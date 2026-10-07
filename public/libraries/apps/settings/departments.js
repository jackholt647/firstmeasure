/* Organization departments: one catalog, edited from either relationship end. */
(function(){
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api=()=>window.PlatformAPI.workforce;
  const reads=new Map();
  async function readSettings(orgId){if(!reads.has(orgId))reads.set(orgId,api().departments(orgId).finally(()=>reads.delete(orgId)));return structuredClone(await reads.get(orgId));}
  function style(){
    if(document.getElementById('fm-departments-style'))return;
    const node=document.createElement('style');node.id='fm-departments-style';node.textContent=`
      .dp-root{display:grid;gap:16px;color:#344054}.dp-root *{box-sizing:border-box}.dp-root h3,.dp-root h4,.dp-root p{margin:0}.dp-help{font-size:12px;color:#667085;line-height:1.5}.dp-layout{display:grid;grid-template-columns:minmax(170px,230px) minmax(0,1fr);gap:18px}.dp-list{display:flex;flex-direction:column;gap:6px;align-self:start}.dp-list button{text-align:left}.dp-root button{cursor:pointer;border:1px solid #d0d5dd;border-radius:8px;padding:8px 12px;background:#fff;color:inherit;font:inherit;font-size:12px}.dp-root button[aria-pressed=true]{background:#f0f4ff;border-color:#98a2b3}.dp-root button:disabled{opacity:.55;cursor:default}.dp-editor{display:grid;gap:14px;min-width:0}.dp-fields{display:grid;grid-template-columns:minmax(0,1fr) 90px;gap:12px}.dp-field{display:grid;gap:6px;font-size:12px;font-weight:600}.dp-root input:not([type=checkbox]),.dp-root select{width:100%;min-width:0;border:1px solid #d0d5dd;border-radius:8px;padding:8px;background:#fff;color:inherit;font:inherit}.dp-root input[type=color]{height:36px;padding:4px}.dp-root fieldset{min-width:0;border:1px solid #e4e7ec;border-radius:10px;padding:12px}.dp-root legend{font-size:12px;font-weight:700}.dp-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:9px;max-height:240px;overflow:auto}.dp-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.5}.dp-check input{margin-top:3px}.dp-check small{display:block;color:#667085}.dp-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dp-status{font-size:12px;min-height:18px}.dp-assignment{padding:12px;border:1px solid #e4e7ec;border-radius:10px;display:grid;gap:10px}.dp-type-controls{display:flex;gap:8px;flex-wrap:wrap}.dp-type-controls>label{flex:1;min-width:170px}@media(max-width:650px){.dp-layout{grid-template-columns:1fr}.dp-options{grid-template-columns:1fr}.dp-list{max-height:180px;overflow:auto}}
    `;document.head.appendChild(node);
  }
  const announce=()=>window.dispatchEvent(new CustomEvent('fm:departments:updated'));
  function checkboxList(field,rows,selected){
    const values=new Set(selected||[]),known=new Set(rows.map(r=>r.id));
    const all=[...rows,...[...values].filter(id=>!known.has(id)).map(id=>({id,name:`${id} (retained assignment)`}))];
    return `<div class="dp-options">${all.map(r=>`<label class="dp-check"><input type="checkbox" data-dp-field="${field}" value="${esc(r.id)}" ${values.has(r.id)?'checked':''}><span>${esc(r.name||r.label||r.id)}</span></label>`).join('')||`<span class="dp-help">${(globalThis.PlatformLanguage?.htmlText("settings","m_1d7c61da5a56c2","None available.") ?? "None available.")}</span>`}</div>`;
  }
  function assignmentIdentity(kind,id){return {field:kind==='role'?'role_ids':kind==='group_kind'?'group_kind_ids':'subject_keys',value:kind==='user'?`organization_user:${id}`:kind==='group'?`resource_group:${id}`:id};}
  async function mountAssignment(host,orgId,kind,id){
    if(!host||!id)return;const token=Symbol();host._departmentMount=token;const active=()=>host.isConnected&&host._departmentMount===token;style();host.classList.add('dp-root');host.dataset.settingsAutosave='off';
    host.innerHTML=`<p class="dp-help">${(globalThis.PlatformLanguage?.htmlText("settings","m_8106b856808735","Loading departments…") ?? "Loading departments…")}</p>`;
    let state;
    const render=()=>{
      if(!active())return;
      const {field,value}=assignmentIdentity(kind,id),user=state.users?.find(u=>u.id===id),group=state.resource_groups?.find(g=>g.id===id);
      const inherited=d=>kind==='user'&&d.role_ids.some(r=>user?.role_ids.includes(r))?(globalThis.PlatformLanguage?.text("settings","m_0a270477a59add","Inherited from user role") ?? "Inherited from user role"):kind==='group'&&d.group_kind_ids.includes(group?.kind_id)?(globalThis.PlatformLanguage?.text("settings","m_d934cc2b978d05","Inherited from group type") ?? "Inherited from group type"):'';
      host.innerHTML=`<section class="dp-assignment"><h4>${kind==='role'||kind==='group_kind'?(globalThis.PlatformLanguage?.htmlText("settings","m_967feb25c6cad7","Default departments") ?? "Default departments"):(globalThis.PlatformLanguage?.htmlText("settings","m_570d421382fbed","Departments") ?? "Departments")}</h4><p class="dp-help">${kind==='role'||kind==='group_kind'?(globalThis.PlatformLanguage?.htmlText("settings","m_f5464054424b45","Applies to every member of this type, including future members.") ?? "Applies to every member of this type, including future members."):(globalThis.PlatformLanguage?.htmlText("settings","m_2ecf878bd727e3","Direct assignments add to role or group-type defaults. Save role/type changes first to refresh inherited memberships.") ?? "Direct assignments add to role or group-type defaults. Save role/type changes first to refresh inherited memberships.")}</p><div class="dp-options">${state.departments.map(d=>`<label class="dp-check"><input type="checkbox" data-dp-assignment value="${esc(d.id)}" ${d[field].includes(value)?'checked':''} ${!state.can_assign[kind]?'disabled':''}><span>${esc(d.label)}${inherited(d)?`<small>${inherited(d)}${d[field].includes(value)?' · also assigned directly':''}</small>`:''}</span></label>`).join('')||`<p class="dp-help">${(globalThis.PlatformLanguage?.htmlText("settings","m_cf30af4c1b0856","Create departments in Settings → Users → Departments.") ?? "Create departments in Settings → Users → Departments.")}</p>`}</div><p class="dp-help"><strong>${(globalThis.PlatformLanguage?.htmlText("settings","m_6b8e4b3f1a7cc9","Inherited memberships:") ?? "Inherited memberships:")}</strong> ${esc(state.departments.filter(d=>inherited(d)).map(d=>d.label).join(', ')||(globalThis.PlatformLanguage?.text("settings","m_2d4ff8a83b1b5c","None") ?? "None"))}</p><p class="dp-help">${(globalThis.PlatformLanguage?.htmlText("settings","m_8bdaf1ba732556","Checkboxes show direct assignments. Inherited memberships remain active when unchecked.") ?? "Checkboxes show direct assignments. Inherited memberships remain active when unchecked.")}</p><div class="dp-actions">${state.can_assign[kind]?`<button type="button" data-dp-save-assignment>${(globalThis.PlatformLanguage?.htmlText("settings","m_a089a1a2df79e8","Save departments") ?? "Save departments")}</button>`:''}<button type="button" data-dp-reload>${(globalThis.PlatformLanguage?.htmlText("settings","m_286f235cc79de7","Reload") ?? "Reload")}</button><span class="dp-status" role="status"></span></div></section>`;
      host.querySelector('[data-dp-reload]').onclick=()=>void load();
      host.querySelector('[data-dp-save-assignment]')?.addEventListener('click',()=>void save().catch(()=>{}));
    };
    let pending=null;
    function save(){
      if(pending)return pending;
      if(!active()||!state?.can_assign[kind])return Promise.resolve();
      const ids=[...host.querySelectorAll('[data-dp-assignment]:checked')].map(el=>el.value);
      const {field,value}=assignmentIdentity(kind,id);
      if(JSON.stringify(ids)===JSON.stringify(state.departments.filter(d=>d[field].includes(value)).map(d=>d.id)))return Promise.resolve();
      host.querySelectorAll('button,input').forEach(el=>el.disabled=true);
      pending=(async()=>{
        try{state=await api().saveDepartmentAssignment(orgId,{kind,id,department_ids:ids,revision:state.revision,legacy_token:state.legacy_token});if(active()){render();host.querySelector('[role=status]').textContent=(globalThis.PlatformLanguage?.text("settings","m_ff6087fc202a31","Departments saved.") ?? "Departments saved.");}announce();}
        catch(error){if(active()){host.querySelector('[role=status]').textContent=error.message||(globalThis.PlatformLanguage?.text("settings","m_b1d5eca65cad81","Could not save departments.") ?? "Could not save departments.");host.querySelectorAll('button,input').forEach(el=>el.disabled=false);}throw error;}
        finally{pending=null;}
      })();
      return pending;
    }
    async function load(){try{state=await readSettings(orgId);if(active())render();}catch(error){if(active())host.textContent=error.message||(globalThis.PlatformLanguage?.text("settings","m_31a18651cb81ee","Could not load departments.") ?? "Could not load departments.");}}
    await load();
    return {save};
  }
  async function mount(host,orgId){
    if(!host)return;const token=Symbol();host._departmentMount=token;const active=()=>host.isConnected&&host._departmentMount===token;style();host.classList.add('dp-root');host.dataset.settingsAutosave='off';
    host.innerHTML=`<p class="dp-help">${(globalThis.PlatformLanguage?.htmlText("settings","m_edcd68da5d4b23","Loading organization departments…") ?? "Loading organization departments…")}</p>`;
    let state,selected='',mode='departments',busy=false;
    const render=()=>{
      if(!active())return;
      host.innerHTML=`<header class="dp-editor"><h3>${(globalThis.PlatformLanguage?.htmlText("settings","m_f7161d1f24e956","Organization departments") ?? "Organization departments")}</h3><p class="dp-help">${(globalThis.PlatformLanguage?.htmlText("settings","m_8f5d10ae9e3dfc","Shared across all branches. Set default departments for user roles and group types, or add individual people and groups. A person or group can belong to multiple departments.") ?? "Shared across all branches. Set default departments for user roles and group types, or add individual people and groups. A person or group can belong to multiple departments.")}</p>${!state.revision?`<p class="dp-help">${(globalThis.PlatformLanguage?.htmlText("settings","m_5147306077d4a3","Existing branch departments are combined here. Saving adopts them as organization settings; existing appointments and presets are retained.") ?? "Existing branch departments are combined here. Saving adopts them as organization settings; existing appointments and presets are retained.")}</p>`:''}<div class="dp-actions"><button type="button" data-dp-mode="departments" aria-pressed="${mode==='departments'}">${(globalThis.PlatformLanguage?.htmlText("settings","m_570d421382fbed","Departments") ?? "Departments")}</button><button type="button" data-dp-mode="assignments" aria-pressed="${mode==='assignments'}">${(globalThis.PlatformLanguage?.htmlText("settings","m_20558f2853e00b","People, roles & groups") ?? "People, roles & groups")}</button></div></header><div data-dp-content></div>`;
      host.querySelectorAll('[data-dp-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.dpMode;void load();});
      const content=host.querySelector('[data-dp-content]');
      if(mode==='assignments'){
        content.innerHTML=`<div class="dp-editor"><div class="dp-type-controls"><label class="dp-field">${(globalThis.PlatformLanguage?.htmlText("settings","m_4297d86c10d006","Assign departments by") ?? "Assign departments by")}<select data-dp-kind><option value="user">${(globalThis.PlatformLanguage?.htmlText("settings","m_ad2f0ca83b8780","Individual user") ?? "Individual user")}</option><option value="role">${(globalThis.PlatformLanguage?.htmlText("settings","m_21037df1b40c09","User type / role") ?? "User type / role")}</option><option value="group">${(globalThis.PlatformLanguage?.htmlText("settings","m_319e5834d71d6f","Individual user group") ?? "Individual user group")}</option><option value="group_kind">${(globalThis.PlatformLanguage?.htmlText("settings","m_f2c096f77350e1","User group type") ?? "User group type")}</option></select></label><label class="dp-field">${(globalThis.PlatformLanguage?.htmlText("settings","m_bca9e3fd6cf405","Choose") ?? "Choose")}<select data-dp-subject></select></label></div><div data-dp-assignment-host></div></div>`;
        const kind=content.querySelector('[data-dp-kind]'),subject=content.querySelector('[data-dp-subject]');
        const open=()=>void mountAssignment(content.querySelector('[data-dp-assignment-host]'),orgId,kind.value,subject.value);
        const choices=()=>{const rows=state[{user:'users',role:'roles',group:'resource_groups',group_kind:'group_kinds'}[kind.value]]||[];subject.innerHTML=`<option value="">${(globalThis.PlatformLanguage?.htmlText("settings","m_2f45efa1cd676a","Choose…") ?? "Choose…")}</option>`+rows.map(r=>`<option value="${esc(r.id)}">${esc(r.name||r.id)}</option>`).join('');content.querySelector('[data-dp-assignment-host]').replaceChildren();};
        kind.onchange=choices;subject.onchange=open;choices();return;
      }
      if(!selected)selected=state.departments[0]?.id||'new';
      const department=state.departments.find(d=>d.id===selected)||{id:'',label:'',color:'#64748b',group_id:'',role_ids:[],group_kind_ids:[],subject_keys:[]};
      content.innerHTML=`<div class="dp-layout"><nav class="dp-list" aria-label="${(globalThis.PlatformLanguage?.htmlText("settings","m_570d421382fbed","Departments") ?? "Departments")}">${state.departments.map(d=>`<button type="button" data-dp-select="${esc(d.id)}" aria-pressed="${selected===d.id}">${esc(d.label)}</button>`).join('')}${state.can_manage?`<button type="button" data-dp-select="new">${(globalThis.PlatformLanguage?.htmlText("settings","m_86433617637bb9","+ Create department") ?? "+ Create department")}</button>`:''}</nav><div class="dp-editor"><div class="dp-fields"><label class="dp-field">${(globalThis.PlatformLanguage?.htmlText("settings","m_ce2f23fc67dbab","Department name") ?? "Department name")}<input data-dp-name value="${esc(department.label)}" maxlength="100"></label><label class="dp-field">${(globalThis.PlatformLanguage?.htmlText("settings","m_db7002926d9977","Color") ?? "Color")}<input type="color" data-dp-color value="${esc(department.color)}"></label></div><label class="dp-field">${(globalThis.PlatformLanguage?.htmlText("settings","m_b53d9744f78699","Department category (optional)") ?? "Department category (optional)")}<input data-dp-category value="${esc(state.groups.find(g=>g.id===department.group_id)?.label||'')}" maxlength="100" placeholder="${(globalThis.PlatformLanguage?.htmlText("settings","m_c73c6e0076f1ad","For example, Customer services") ?? "For example, Customer services")}"></label><fieldset><legend>${(globalThis.PlatformLanguage?.htmlText("settings","m_02997de9e09d60","User types / roles — default members") ?? "User types / roles — default members")}</legend>${checkboxList('role_ids',state.roles||[],department.role_ids)}</fieldset><fieldset><legend>${(globalThis.PlatformLanguage?.htmlText("settings","m_8dde7f5f579699","User group types — default groups") ?? "User group types — default groups")}</legend>${checkboxList('group_kind_ids',state.group_kinds||[],department.group_kind_ids)}</fieldset><fieldset><legend>${(globalThis.PlatformLanguage?.htmlText("settings","m_ec049efefe3343","Additional individual users") ?? "Additional individual users")}</legend>${checkboxList('users',(state.users||[]).map(u=>({...u,id:`organization_user:${u.id}`})),department.subject_keys.filter(k=>k.startsWith('organization_user:')))}</fieldset><fieldset><legend>${(globalThis.PlatformLanguage?.htmlText("settings","m_6ea7e974e821fc","Additional individual user groups") ?? "Additional individual user groups")}</legend>${checkboxList('groups',(state.resource_groups||[]).map(g=>({...g,id:`resource_group:${g.id}`})),department.subject_keys.filter(k=>k.startsWith('resource_group:')))}</fieldset><div class="dp-actions">${state.can_manage?`<button type="button" data-dp-save>${(globalThis.PlatformLanguage?.htmlText("settings","m_9c29c0605b9630","Save department") ?? "Save department")}</button>`:''}<button type="button" data-dp-refresh>${(globalThis.PlatformLanguage?.htmlText("settings","m_286f235cc79de7","Reload") ?? "Reload")}</button><span class="dp-status" role="status"></span></div></div></div>`;
      content.querySelectorAll('[data-dp-select]').forEach(b=>b.onclick=()=>{selected=b.dataset.dpSelect;render();});
      if(!state.can_manage)content.querySelectorAll('input').forEach(el=>el.disabled=true);
      content.querySelector('[data-dp-refresh]').onclick=()=>void load();
      content.querySelector('[data-dp-save]')?.addEventListener('click',async()=>{
        if(busy)return;
        const name=content.querySelector('[data-dp-name]').value.trim(),status=content.querySelector('[role=status]');
        if(!name){status.textContent=(globalThis.PlatformLanguage?.text("settings","m_cfa69cfd76ca26","Enter a department name.") ?? "Enter a department name.");content.querySelector('[data-dp-name]').focus();return;}
        const next=structuredClone(state),category=content.querySelector('[data-dp-category]').value.trim();
        let categoryId=next.groups.find(g=>g.label.toLowerCase()===category.toLowerCase())?.id||'';
        if(category&&!categoryId){categoryId=crypto.randomUUID();next.groups.push({id:categoryId,label:category});}
        const checked=field=>[...content.querySelectorAll(`[data-dp-field="${field}"]:checked`)].map(el=>el.value);
        const row={...department,id:department.id||crypto.randomUUID(),label:name,color:content.querySelector('[data-dp-color]').value,group_id:categoryId,role_ids:checked('role_ids'),group_kind_ids:checked('group_kind_ids'),subject_keys:[...checked('users'),...checked('groups'),...department.subject_keys.filter(key=>!key.startsWith('organization_user:')&&!key.startsWith('resource_group:'))]};
        next.departments=department.id?next.departments.map(d=>d.id===row.id?row:d):[...next.departments,row];
        busy=true;host.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);
        try{state=await api().saveDepartments(orgId,{departments:next.departments,groups:next.groups,revision:state.revision,legacy_token:state.legacy_token});selected=row.id;if(active()){render();host.querySelector('[role=status]').textContent=(globalThis.PlatformLanguage?.text("settings","m_0c44938a138aa6","Department saved.") ?? "Department saved.");}announce();}
        catch(error){status.textContent=error.message||(globalThis.PlatformLanguage?.text("settings","m_8a36512cbfe084","Could not save department.") ?? "Could not save department.");host.querySelectorAll('button,input,select').forEach(el=>el.disabled=false);}finally{busy=false;}
      });
    };
    let pending=null;
    function save(){
      if(pending)return pending;
      if(!active()||!state?.can_assign[kind])return Promise.resolve();
      const ids=[...host.querySelectorAll('[data-dp-assignment]:checked')].map(el=>el.value);
      const {field,value}=assignmentIdentity(kind,id);
      if(JSON.stringify(ids)===JSON.stringify(state.departments.filter(d=>d[field].includes(value)).map(d=>d.id)))return Promise.resolve();
      host.querySelectorAll('button,input').forEach(el=>el.disabled=true);
      pending=(async()=>{
        try{state=await api().saveDepartmentAssignment(orgId,{kind,id,department_ids:ids,revision:state.revision,legacy_token:state.legacy_token});if(active()){render();host.querySelector('[role=status]').textContent=(globalThis.PlatformLanguage?.text("settings","m_ff6087fc202a31","Departments saved.") ?? "Departments saved.");}announce();}
        catch(error){if(active()){host.querySelector('[role=status]').textContent=error.message||(globalThis.PlatformLanguage?.text("settings","m_b1d5eca65cad81","Could not save departments.") ?? "Could not save departments.");host.querySelectorAll('button,input').forEach(el=>el.disabled=false);}throw error;}
        finally{pending=null;}
      })();
      return pending;
    }
    async function load(){try{state=await readSettings(orgId);if(active())render();}catch(error){if(active())host.textContent=error.message||(globalThis.PlatformLanguage?.text("settings","m_31a18651cb81ee","Could not load departments.") ?? "Could not load departments.");}}
    await load();
    return {save};
  }
  window.FirstMateDepartments={mount,mountAssignment};
})();
