/* Appointment presets are administered in Settings, never in booking. */
(function(){
  if(window.FirstMateAppointmentSettings)return;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function mount(host,orgId){
    if(!window.FirstMateAppointmentConfiguration){await(window.__appointmentConfigurationLoading||=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/libraries/appointment-booking/configuration.js?v=20261005-compact-booking-v2';s.onload=resolve;s.onerror=()=>reject(Error('Could not load appointment settings.'));document.head.append(s);}));}
    let response=await PlatformAPI.appointments.catalog(orgId),editor=null,selected='',busy=false;
    if(!host.isConnected)return;
    host.innerHTML=`<section class="cs-section fm-ap-admin" data-settings-autosave="off"><h3>Appointment presets</h3><div class="fm-ap-admin-layout"><div><input type="search" data-preset-search placeholder="Search presets" aria-label="Search presets"><div data-preset-list></div>${response.can_manage?'<button type="button" data-new-preset>+ New preset</button>':''}</div><div data-preset-editor></div></div><div role="status" data-preset-status></div></section>`;
    const $=s=>host.querySelector(s),status=text=>$('[data-preset-status]').textContent=text;
    function setBusy(value){busy=value;host.querySelectorAll('[data-edit-preset],[data-new-preset]').forEach(button=>button.disabled=value);}
    function list(){const query=$('[data-preset-search]').value.toLowerCase();$('[data-preset-list]').innerHTML=response.catalog.presets.filter(p=>p.label.toLowerCase().includes(query)).map(p=>`<button type="button" data-edit-preset="${esc(p.id)}" aria-pressed="${p.id===selected}">${esc(p.label)}</button>`).join('');host.querySelectorAll('[data-edit-preset]').forEach(b=>b.onclick=()=>{if(!busy)void edit(b.dataset.editPreset);});}
    async function edit(id){
      selected=id;editor?.destroy();editor=null;status('');list();const preset=response.catalog.presets.find(p=>p.id===id),target=$('[data-preset-editor]');
      target.innerHTML=`<fieldset ${response.can_manage?'':'disabled'}><label class="fm-ap-admin-label">Preset name<input data-preset-label maxlength="100" value="${esc(preset?.label||'')}"></label><div data-preset-config></div><div class="fm-ap-admin-actions">${response.can_manage?`<button type="button" data-save-preset>Save preset</button>${preset?'<button type="button" data-delete-preset>Delete preset</button>':''}`:''}</div></fieldset>`;
      const fieldset=target.querySelector('fieldset');setBusy(true);fieldset.disabled=true;
      try{editor=await FirstMateAppointmentConfiguration.mount($('[data-preset-config]'),{orgId,settingsMode:true,initialValue:preset?.configuration});}catch(error){status(error.message);}finally{setBusy(false);fieldset.disabled=!response.can_manage;}
      async function save(remove=false){
        if(busy||!editor)return;const label=$('[data-preset-label]').value.trim();if(!remove&&!label){status('Enter a preset name.');$('[data-preset-label]').focus();return;}
        const catalog=structuredClone(response.catalog),presetId=id||crypto.randomUUID(),configuration=editor.value;delete configuration.preset_id;
        catalog.presets=catalog.presets.filter(p=>p.id!==presetId);if(!remove)catalog.presets.push({id:presetId,label,configuration});
        setBusy(true);fieldset.disabled=true;
        try{response=await PlatformAPI.appointments.saveCatalog(orgId,{catalog,revision:response.revision});setBusy(false);await edit(remove?'':presetId);status(remove?'Preset deleted.':'Preset saved.');}
        catch(error){status(error.message||'Could not save preset.');}finally{setBusy(false);if(fieldset.isConnected)fieldset.disabled=false;}
      }
      $('[data-save-preset]')?.addEventListener('click',()=>void save());
      $('[data-delete-preset]')?.addEventListener('click',()=>void save(true));
    }
    $('[data-preset-search]').oninput=list;$('[data-new-preset]')?.addEventListener('click',()=>{if(!busy)void edit('');});
    await edit(response.catalog.presets[0]?.id||'');
    if(response.can_manage){
      const departmentHost=document.createElement('div');departmentHost.className='fm-ap-department-settings';host.querySelector('section').append(departmentHost);
      if(PlatformAPI.workforce?.departments){
        departmentHost.innerHTML='<button type="button">Manage departments</button>';
        departmentHost.querySelector('button').onclick=()=>window.Portal?.navigation?.navigate({tab:'company_settings',sub:'departments',settingsView:''},{source:'appointment-settings',ownedKeys:['tab','sub','settingsView']});
      }else{
        departmentHost.innerHTML=`<details><summary>Departments</summary><form><label>Department<select data-department-edit><option value="">New department</option>${response.catalog.departments.map(d=>`<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('')}</select></label><label>Name<input data-department-name required maxlength="100"></label><label>Color<input type="color" data-department-color value="#64748b"></label><label>Scheduling group<input data-department-group maxlength="100"></label><div data-department-members>${response.resources.map(r=>`<label><input type="checkbox" value="${esc(r.key)}">${esc(r.name)}</label>`).join('')}</div><button type="submit">Save department</button></form></details>`;
        const d=s=>departmentHost.querySelector(s);
        d('[data-department-edit]').onchange=()=>{const row=response.catalog.departments.find(r=>r.id===d('[data-department-edit]').value);d('[data-department-name]').value=row?.label||'';d('[data-department-color]').value=row?.color||'#64748b';d('[data-department-group]').value=response.catalog.groups.find(g=>g.id===row?.group_id)?.label||'';departmentHost.querySelectorAll('[type=checkbox]').forEach(input=>input.checked=row?.subject_keys.includes(input.value)||false);};
        d('form').onsubmit=async event=>{event.preventDefault();if(busy)return;const catalog=structuredClone(response.catalog),old=catalog.departments.find(r=>r.id===d('[data-department-edit]').value),label=d('[data-department-name]').value.trim();if(!label)return;const groupLabel=d('[data-department-group]').value.trim();let group=catalog.groups.find(g=>g.label===groupLabel);if(groupLabel&&!group){group={id:crypto.randomUUID(),label:groupLabel};catalog.groups.push(group);}const department={id:old?.id||crypto.randomUUID(),label,color:d('[data-department-color]').value,group_id:group?.id||'',role_ids:old?.role_ids||[],group_kind_ids:old?.group_kind_ids||[],subject_keys:[...departmentHost.querySelectorAll('[type=checkbox]:checked')].map(i=>i.value)};catalog.departments=old?catalog.departments.map(r=>r.id===old.id?department:r):[...catalog.departments,department];setBusy(true);const button=d('[type=submit]');button.disabled=true;try{response=await PlatformAPI.appointments.saveCatalog(orgId,{catalog,revision:response.revision});setBusy(false);await edit(selected);if(!old){const option=new Option(label,department.id);d('[data-department-edit]').add(option);}else d('[data-department-edit]').selectedOptions[0].textContent=label;d('[data-department-edit]').value=department.id;status('Department saved.');}catch(error){status(error.message||'Could not save department.');}finally{setBusy(false);button.disabled=false;}};
      }
    }
    return {destroy(){editor?.destroy();host.replaceChildren();}};
  }
  window.FirstMateAppointmentSettings={mount};
})();
