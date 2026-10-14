// People settings: the category shell, the shared pieces and the Users page, in a real browser with stubbed APIs.
// PEOPLE_SCREENSHOTS=1 writes screenshots to <repo>/output/people-ui/.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';

const libraries = new URL('../../libraries/', import.meta.url);
const shots = process.env.PEOPLE_SCREENSHOTS ? path.resolve(import.meta.dirname, '..', '..', '..', 'output', 'people-ui') : '';
// The two slot panels are other modules' work; most cases run without them so the slot contract itself is what is tested.
const PANELS = ['fields-panel', 'compensation-panel'];
const FILES = ['people-kit', 'list-page', 'entity-modal', 'hover-card', 'permissions-panel', 'app-grid', 'slots', 'people-data', 'people-directory', 'page-kit', 'people-lists', 'users-page', 'groups-page', 'departments-page', 'companies-page', 'people-home', 'people-settings'];
const TABS = ['home', 'users', 'groups', 'departments', 'subcontractors'];

// A stand-in for the Settings shell: the same grid, card and sub-tab hoisting the real shell applies to a category pane.
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
<style>
  :root{--primary:#d93025;--primary-readable:#c5221f;--primary-rgb:217,48,37;--on-primary:#fff}
  html,body{height:100%;margin:0;background:#f0f2f5;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#101828}
  #tab_company_settings{height:100%;padding:18px 22px;box-sizing:border-box}
  .cs-wrap{height:100%}.cs-layout{display:grid;grid-template-columns:230px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);grid-template-areas:'title subtabs' 'sidebar content';column-gap:28px;row-gap:12px;height:100%}
  .cs-heading{grid-area:title;padding:8px 0}.cs-title{margin:0;font-size:26px;font-weight:900;letter-spacing:-.5px}
  .cs-sidebar{grid-area:sidebar;display:flex;flex-direction:column;gap:3px}.cs-tab{display:flex;gap:10px;align-items:center;padding:9px 11px;border:0;border-radius:10px;background:transparent;color:#475467;font:650 12.5px/1 inherit;text-align:left}.cs-tab.active{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.1)}.cs-tab i{width:16px;text-align:center;color:#98a2b3}
  .cs-subtabs-slot{grid-area:subtabs;justify-self:end;align-self:start}.cs-subtabs-slot>*{margin:0!important}
  [data-settings-subtabs-source]{display:none!important}
  .cs-main{grid-area:content;min-width:0;min-height:0}.cs-layout.no-subtabs .cs-main{grid-row:1/3}
  .cs-main>.cs-card{height:100%;box-sizing:border-box;background:#fff;border:1px solid #e4e7ec;border-radius:16px;box-shadow:0 10px 28px rgba(15,23,42,.055);padding:18px;overflow-x:hidden;overflow-y:auto}
  .cs-pane{display:none}.cs-pane.active{display:block}
  @media(max-width:1100px){#tab_company_settings{padding:0;height:auto}.cs-layout{display:block;height:auto}.cs-sidebar{display:none}.cs-heading{padding:12px 16px 4px}.cs-subtabs-slot{padding:6px 12px;overflow-x:auto}.cs-main>.cs-card{height:auto;border:0;border-radius:0;box-shadow:none;padding:16px}}
</style></head><body>
<div id="tab_company_settings"><div class="cs-wrap"><div class="cs-layout no-subtabs">
  <header class="cs-heading"><h2 class="cs-title">People</h2></header>
  <aside class="cs-sidebar">${['fa-user-gear|My Settings', 'fa-building|Company', 'fa-users|People', 'fa-money-check-dollar|Payroll', 'fa-calendar-days|Scheduling', 'fa-layer-group|Project Scopes'].map((entry) => { const [icon, label] = entry.split('|'); return `<button class="cs-tab ${label === 'People' ? 'active' : ''}"><i class="fas ${icon}"></i>${label}</button>`; }).join('')}</aside>
  <div class="cs-subtabs-slot" data-settings-subtabs-slot hidden></div>
  <main class="cs-main"><div class="cs-card"><div class="cs-pane" id="csPanePeople" data-settings-pane="people"></div></div></main>
</div></div></div></body></html>`;

function stubPlatform(){
  const first = ['Ana', 'Ben', 'Carla', 'Dmitri', 'Elena', 'Farid', 'Grace', 'Hugo', 'Ines', 'Jamal', 'Keiko', 'Liam', 'Mara', 'Noor', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sven', 'Tessa', 'Uma', 'Victor', 'Wren', 'Xavier', 'Yara', 'Zane'];
  const last = ['Lopez', 'Okafor', 'Rossi', 'Volkov', 'Marin', 'Haddad', 'Chen', 'Bernard', 'Duarte', 'Wright', 'Tanaka', 'Murphy', 'Novak', 'Rahman', 'Farouk', 'Nair', 'Avery', 'Delgado', 'Lindqvist', 'Boyd'];
  const roles = [
    { id:'admin', name:'Administrator', description:'Runs the company account', application_ids:['management'], is_system:true, permissions:{ '*':true }, app_defaults:{}, revision:3 },
    { id:'office', name:'Office manager', description:'Scheduling, billing and people', application_ids:['management'], permissions:{ manage_company_users:true, manage_schedule:true, view_projects:true, manage_projects:true, view_reports:true }, app_defaults:{}, revision:2 },
    { id:'sales', name:'Sales', description:'Sells and follows up', application_ids:['management', 'field'], permissions:{ view_projects:true, 'sales.dashboard.view':true, 'sales.schedule.view':true, 'sales.followups.manage':true, 'sales.earnings.view':true }, app_defaults:{ 'portal.payroll':{ enabled:false } }, revision:5 },
    { id:'production', name:'Production', description:'Plans and runs installs', application_ids:['management'], permissions:{ view_projects:true, manage_projects:true, manage_schedule:true, view_schedule:true }, app_defaults:{}, revision:1 },
    { id:'crew_foreman', name:'Foreman', description:'Leads a group in the field', application_ids:['field'], is_system:true, permissions:{ 'crew.dashboard.view':true, 'crew.projects.view':true, 'crew.schedule.view':true, 'crew.time_clock.use':true, 'crew.checklists.view':true, 'crew.checklists.complete':true, 'crew.materials.view':true, 'crew.payments.take':true }, app_defaults:{}, revision:1 },
    { id:'crew_member', name:'Installer', description:'Works in the field', application_ids:['field'], is_system:true, permissions:{ 'crew.dashboard.view':true, 'crew.projects.view':true, 'crew.schedule.view':true, 'crew.time_clock.use':true, 'crew.checklists.view':true }, app_defaults:{}, revision:1 },
    { id:'phones', name:'Phones', description:'Answers and places calls', application_ids:['management'], permissions:{ view_projects:true, use_phone:true }, app_defaults:{}, revision:1 }
  ];
  const tab = (id, title, icon, application, surface = 'portal_tab', extra = {}) => ({ id, title, icon, description:`${title} for the ${application === 'field' ? 'field' : 'office'}`, application_id:application, surface, kind:surface === 'portal_tab' ? 'portal_tab' : 'project_modal_app', devices:['mobile', 'desktop'], required_permissions:[], parameter_permissions:{}, default_enabled:true, order:0, ...extra });
  const apps = [
    tab('portal.viewer', 'My Projects', 'fa-briefcase', 'management'), tab('portal.contacts', 'My Contacts', 'fa-address-book', 'management'), tab('portal.photos_feed', 'Feed', 'fa-images', 'management'),
    tab('portal.proposals', 'Proposals', 'fa-file-signature', 'management'), tab('portal.scheduling', 'Scheduling', 'fa-calendar-days', 'management', 'portal_tab', { required_permissions:['view_schedule'] }), tab('portal.invoices', 'Invoices', 'fa-file-invoice-dollar', 'management'),
    tab('portal.financials', 'Financials', 'fa-chart-line', 'management', 'portal_tab', { devices:['desktop'] }), tab('portal.payroll', 'Payroll', 'fa-money-check-dollar', 'management', 'portal_tab', { devices:['desktop'] }), tab('portal.calls', 'Calls', 'fa-phone', 'management', 'portal_tab', { required_permissions:['use_phone'] }),
    tab('portal.canvassing', 'Canvassing', 'fa-map-location-dot', 'management'), tab('portal.company_settings', 'Settings', 'fa-gear', 'management'),
    tab('project.map', 'Project Overview', 'fa-map', 'management', 'project_modal'), tab('project.photos', 'Project Photos', 'fa-camera', 'management', 'project_modal'), tab('project.proposal', 'Project Proposals', 'fa-file-signature', 'management', 'project_modal'),
    tab('project.docs', 'Project Docs', 'fa-folder-open', 'management', 'project_modal'), tab('project.materials', 'Scope', 'fa-clipboard-list', 'management', 'project_modal'), tab('project.money', 'Money', 'fa-wallet', 'management', 'project_modal'),
    tab('project.schedule', 'Project Schedule', 'fa-calendar-days', 'management', 'project_modal'), tab('project.measurements', 'Reports', 'fa-ruler-combined', 'management', 'project_modal'), tab('project.checklists', 'Checklists', 'fa-list-check', 'management', 'project_modal'),
    tab('portal.crew_overview', 'Today', 'fa-sun', 'field'), tab('portal.crew_schedule', 'Schedule', 'fa-calendar-week', 'field'), tab('portal.crew_payouts', 'Earnings', 'fa-sack-dollar', 'field'), tab('portal.crew_receipts', 'Receipts', 'fa-receipt', 'field', 'portal_tab', { devices:['mobile'] }),
    tab('project.crew_overview', 'Visit', 'fa-location-dot', 'field', 'project_modal'), tab('project.crew_materials', 'Materials', 'fa-boxes-stacked', 'field', 'project_modal'), tab('project.crew_payments', 'Payments', 'fa-credit-card', 'field', 'project_modal')
  ];
  const departments = [
    { id:'sales', label:'Sales', color:'#2563eb', status:'active', subject_keys:[], role_ids:['sales'], group_kind_ids:[] },
    { id:'production', label:'Production', color:'#16a34a', status:'active', subject_keys:[], role_ids:['production', 'crew_foreman', 'crew_member'], group_kind_ids:[] },
    { id:'office', label:'Office', color:'#9333ea', status:'active', subject_keys:[], role_ids:['office'], group_kind_ids:[] },
    { id:'service', label:'Service and warranty', color:'#ea580c', status:'active', subject_keys:[], role_ids:[], group_kind_ids:[] },
    { id:'warehouse', label:'Warehouse', color:'#0891b2', status:'active', subject_keys:[], role_ids:[], group_kind_ids:[] }
  ];
  const pattern = [['admin'], ['office'], ['sales'], ['sales', 'phones'], ['production'], ['crew_foreman'], ['crew_member'], ['crew_member'], ['sales', 'production', 'phones'], ['phones']];
  const users = Array.from({ length:42 }, (_, index) => {
    const id = `u${index + 1}`;
    const name = index === 7 ? 'Maximiliano Alexander Fitzgerald-Montgomery III' : `${first[index % first.length]} ${last[(index * 7) % last.length]}`;
    const never = [4, 17, 30].includes(index);
    return {
      id, name, email:`${name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@northwind-exteriors.example`,
      status:never ? 'invited' : index === 12 ? 'disabled' : 'active', disabled:index === 12, last_login_at:never ? '' : '2026-10-10T15:00:00Z', created_at:'2026-03-02T15:00:00Z', invited_at:'2026-10-01T15:00:00Z',
      phone:index % 3 === 0 ? '(555) 010-' + String(1000 + index) : '', role:index === 0 ? 'super_admin' : 'viewer',
      access_role_ids:index === 8 ? ['admin', 'office', 'sales', 'production', 'phones'] : pattern[index % pattern.length],
      permission_overrides:index === 2 ? { 'sales.earnings.view':false } : {}, app_access_overrides:{},
      profile_photo_url:index % 6 === 1 ? `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="hsl(${index * 37 % 360} 45% 62%)"/><circle cx="48" cy="38" r="17" fill="rgba(255,255,255,.85)"/><rect x="18" y="62" width="60" height="44" rx="22" fill="rgba(255,255,255,.85)"/></svg>`)}` : ''
    };
  });
  departments.find((department) => department.id === 'service').subject_keys.push('organization_user:u3', 'organization_user:u9');
  departments.find((department) => department.id === 'production').icon = 'fa-helmet-safety';
  departments.find((department) => department.id === 'sales').icon = 'fa-handshake';
  departments.find((department) => department.id === 'warehouse').subject_keys.push('organization_user:u9');
  const groups = [
    { id:'g1', name:'North team', kind_id:'crew', status:'active', members:[{ user_id:'u6' }, { user_id:'u7' }, { user_id:'u9' }] },
    { id:'g2', name:'Closers', kind_id:'sales_team', status:'active', members:[{ user_id:'u3' }, { user_id:'u9' }] }
  ];
  const calls = [];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const memberships = () => users.map((user) => {
    const sources = departments.flatMap((department) => [
      ...(department.subject_keys.includes(`organization_user:${user.id}`) ? [{ department_id:department.id, kind:'direct', id:user.id }] : []),
      ...department.role_ids.filter((roleId) => user.access_role_ids.includes(roleId)).map((roleId) => ({ department_id:department.id, kind:'role', id:roleId }))
    ]);
    return { id:user.id, department_ids:[...new Set(sources.map((source) => source.department_id))], division_ids:[], sources };
  });
  const divisions = [{ id:'north', label:'North region', kind:'Region', parent_id:'', branch_id:'', status:'active', subject_keys:[] }];
  const categories = [{ id:'field', label:'Field' }];
  window.__departmentExtras = { divisions, categories };
  const departmentState = () => copy({ revision:4, legacy_token:'', departments, divisions, groups:categories, terminology:window.__departmentExtras.terminology || { department:{ singular:'Department', plural:'Departments' } }, effective_memberships:memberships(), can_manage:true, can_assign:{ user:true, role:true, group:true } });
  const normalize = (doc) => { const data = doc?.data && typeof doc.data === 'object' ? { id:doc.id, ...doc.data } : { ...(doc || {}) }; return { ...data, disabled:data.disabled === true || data.status === 'disabled' }; };
  window.__people = { calls, users, roles, departments, toasts:[], presence:null, routes:[], route:{ sub:'people', settingsView:'', settingsEntity:'' }, flags:{} };
  window.__APP = { userOrgId:'org', userId:'u1', userEmail:users[0].email, userName:users[0].name };
  window.Portal = {
    util:{ hasPerm:() => true },
    ui:{ showToast:(title, message, ok) => { window.__people.toasts.push({ title, message, ok }); window.PlatformUI?.showToast?.(title, message, ok); } },
    terminology:{ get:(key, fallback) => ({ 'workforce.resource_group_plural':'Crews and teams', 'workforce.resource_group_singular':'Crew or team' }[key] || fallback) },
    navigation:{ read:() => ({ ...window.__people.route }), write:(route) => { window.__people.routes.push(route); }, navigate:(route) => { window.__people.routes.push({ navigate:route }); } }
  };
  window.PlatformRealtime = { watchPresence(orgId, scope, listener){ window.__people.presence = listener; listener([]); return () => { window.__people.presence = null; }; } };
  window.PlatformAPI = {
    appFlags:{ has:(group, flag) => window.__people.flags[`${group}.${flag}`] !== false, value:() => undefined, current:() => ({}) },
    users:{
      normalize,
      list:async () => ({ users:copy(users) }),
      create:async (orgId, body) => { const data = body.data || body; const user = { id:`u${users.length + 1}`, created_at:'2026-10-13T12:00:00Z', invited_at:'2026-10-13T12:00:00Z', last_login_at:'', permission_overrides:{}, app_access_overrides:{}, ...data }; users.push(user); calls.push({ op:'create', data }); return { document:{ id:user.id, data:copy(user) }, emailed:true }; },
      patch:async (orgId, id, patch) => { Object.assign(users.find((user) => user.id === id), patch); calls.push({ op:'patch', id, patch }); return { document:{ id, data:copy(users.find((user) => user.id === id)) } }; },
      setDisabled:async (orgId, id, disabled) => { const user = users.find((entry) => entry.id === id); user.status = disabled ? 'disabled' : 'active'; user.disabled = !!disabled; calls.push({ op:'setDisabled', id, disabled }); return { document:{ id, data:copy(user) } }; },
      resendInvite:async (orgId, id) => { calls.push({ op:'resendInvite', id }); return { ok:true, emailed:true }; },
      remove:async (orgId, id) => { users.splice(users.findIndex((user) => user.id === id), 1); calls.push({ op:'remove', id }); return { ok:true }; },
      setPermissions:async (orgId, id, level, items) => { const user = users.find((entry) => entry.id === id); user.role = level; user.org_permissions = { level, items }; calls.push({ op:'setPermissions', id, level, items }); return { document:{ id, data:copy(user) } }; }
    },
    workforce:{
      users:async () => ({ users:copy(users) }),
      accessCatalog:async () => copy({ applications:[{ id:'management', label:'Office' }, { id:'field', label:'Field' }], permission_keys:['crew.dashboard.view', 'crew.projects.view', 'crew.projects.view_all_production', 'crew.schedule.view', 'crew.time_clock.use', 'crew.receipts.upload', 'crew.reimbursements.request', 'crew.materials.view', 'crew.materials.append', 'crew.payouts.view', 'crew.checklists.view', 'crew.checklists.complete', 'crew.payments.view', 'crew.payments.take', 'sales.dashboard.view', 'sales.schedule.view', 'sales.followups.manage', 'sales.earnings.view', 'sales.documents.view_status', 'sales.money.view_status', 'sales.stats.view_own', 'sales.stats.view_team', 'manage_billing', 'manage_company_settings', 'manage_company_user_permissions', 'order_reports', 'manage_report_settings', 'manage_payroll'], apps, roles }),
      departments:async () => departmentState(),
      saveDepartments:async (orgId, payload) => { calls.push({ op:'saveDepartments', payload:copy(payload) }); departments.splice(0, departments.length, ...copy(payload.departments)); divisions.splice(0, divisions.length, ...copy(payload.divisions || [])); categories.splice(0, categories.length, ...copy(payload.groups || [])); if (payload.terminology) window.__departmentExtras.terminology = copy(payload.terminology); return departmentState(); },
      saveDepartmentAssignment:async (orgId, payload) => { calls.push({ op:'saveDepartmentAssignment', payload }); const key = `${payload.kind === 'group' ? 'resource_group' : payload.kind === 'connection' ? 'organization_connection' : 'organization_user'}:${payload.id}`; departments.forEach((department) => { department.subject_keys = department.subject_keys.filter((entry) => entry !== key); if (payload.department_ids.includes(department.id)) department.subject_keys.push(key); }); return departmentState(); },
      resourceGroups:async () => ({ resource_groups:copy(groups) }),
      configuration:async () => ({ configuration:{ revision:1, terminology:{} } }),
      saveUserProfile:async (orgId, id, profile) => { const user = users.find((entry) => entry.id === id); Object.assign(user, profile); calls.push({ op:'saveUserProfile', id, profile:copy(profile) }); return { document:{ id, data:copy(user) } }; },
      updateAccessRole:async (orgId, id, patch) => { const role = roles.find((entry) => entry.id === id); const { expected_revision, ...rest } = patch; Object.assign(role, rest, { revision:role.revision + 1 }); calls.push({ op:'updateAccessRole', id, patch:copy(patch) }); return { role:copy(role) }; },
      createAccessRole:async (orgId, role) => { const created = { id:`role_${roles.length + 1}`, revision:1, status:'active', ...role }; roles.push(created); calls.push({ op:'createAccessRole', role:copy(role) }); return { role:copy(created) }; },
      archiveAccessRole:async (orgId, id) => { roles.find((entry) => entry.id === id).status = 'archived'; calls.push({ op:'archiveAccessRole', id }); return { ok:true }; }
    }
  };
}

// Groups, outside companies, their types, the published assignee directory and the assignees.* actions.
function stubDirectory(){
  const { users, roles, departments, calls } = window.__people;
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const types = [
    { id:'crew', name:'Install crew', description:'Works a job together in the field', status:'active', kind:'resource_group', member_role_ids:['crew_member'] },
    { id:'sales_team', name:'Sales team', description:'Shares leads and appointments', status:'active', kind:'resource_group', member_role_ids:[] },
    { id:'service_team', name:'Service team', description:'', status:'active', kind:'resource_group', member_role_ids:[] },
    { id:'roofing_sub', name:'Roofing', description:'Installs roofs', status:'active', kind:'organization_connection', member_role_ids:[] },
    { id:'gutters_sub', name:'Gutters', description:'', status:'active', kind:'organization_connection', member_role_ids:[] },
    { id:'electrical_sub', name:'Electrical', description:'', status:'active', kind:'organization_connection', member_role_ids:[] },
    { id:'dumpster', name:'Debris hauling', description:'', status:'active', kind:'organization_connection', member_role_ids:[] }
  ];
  const member = (userId, lead = false, joined = []) => ({ user_id:userId, role:lead ? 'lead' : 'member', is_lead:lead, status:'active', joined_role_ids:joined });
  const groups = [
    { id:'g1', name:'North team', kind_id:'crew', status:'active', revision:3, assignment_tag_ids:['shingle'], capability_scope_ids:['roofing'], members:[member('u6', true), member('u7', false, ['crew_member']), member('u8'), member('u9'), member('u16'), member('u17'), member('u26')] },
    { id:'g2', name:'Closers', kind_id:'sales_team', status:'active', revision:1, assignment_tag_ids:[], capability_scope_ids:[], members:[member('u3', true), member('u4'), member('u9')] },
    { id:'g3', name:'South team', kind_id:'crew', status:'active', revision:2, assignment_tag_ids:['metal'], capability_scope_ids:['roofing', 'gutters'], members:[member('u27', true), member('u28'), member('u36')] },
    { id:'g4', name:'Warranty and repair response team for the northern counties', kind_id:'service_team', status:'active', revision:1, assignment_tag_ids:[], capability_scope_ids:[], members:[member('u5')] },
    { id:'g5', name:'Canvassers', kind_id:'sales_team', status:'active', revision:1, assignment_tag_ids:[], capability_scope_ids:[], members:[] }
  ];
  departments.find((department) => department.id === 'production').group_kind_ids.push('crew');
  departments.find((department) => department.id === 'sales').subject_keys.push('resource_group:g2');
  const connections = [
    { id:'c1', name:'Summit Roofing', legal_name:'Summit Roofing LLC', status:'active', revision:4, contacts:[{ id:'primary', primary:true, name:'Dale Whitaker', email:'dale@summitroofing.example', phone:'(555) 014-2200' }], address:{ line1:'410 Quarry Rd', city:'Asheville', region:'NC', postal_code:'28801' }, capability_scope_ids:['roofing'], linked_organization_id:'org_summit', link_status:'linked', payment_terms:{ basis:'net_days', net_days:15 }, metadata:{ external_reference:'V-1042' } },
    { id:'c2', name:'Blue Ridge Seamless Gutters and Exterior Drainage', legal_name:'Blue Ridge Seamless Inc.', status:'active', revision:2, contacts:[{ id:'primary', primary:true, name:'Mina Cho', email:'mina@blueridge.example', phone:'' }], address:{}, capability_scope_ids:['gutters'], linked_organization_id:'org_blue', link_status:'pending', payment_terms:{}, metadata:{} },
    { id:'c3', name:'Volt Brothers', legal_name:'', status:'active', revision:1, contacts:[], address:{}, capability_scope_ids:[], linked_organization_id:null, link_status:'unlinked', payment_terms:{}, metadata:{} },
    { id:'c4', name:'Haul Away', legal_name:'Haul Away Disposal Co.', status:'active', revision:1, contacts:[{ id:'primary', primary:true, name:'Rosa Pine', email:'', phone:'(555) 014-9911' }], address:{}, capability_scope_ids:[], linked_organization_id:null, link_status:'unlinked', payment_terms:{}, metadata:{} }
  ];
  const companyTypes = { c1:['roofing_sub', 'gutters_sub', 'dumpster'], c2:['gutters_sub'], c3:['electrical_sub'], c4:['dumpster'] };
  const staffing = { g1:[{ id:'cdl', label:'CDL driver', count:1, where:{ rules:[{ field:'fields.has_cdl', operator:'equals', value:true }] } }] };
  const tags = [{ id:'shingle', name:'Shingle', status:'active' }, { id:'metal', name:'Metal', status:'active' }, { id:'bilingual', name:'Bilingual', status:'active' }];
  const scopes = [{ id:'roofing', name:'Roofing' }, { id:'gutters', name:'Gutters' }, { id:'siding', name:'Siding' }];
  const typeNames = (ids) => ids.map((id) => types.find((type) => type.id === id)?.name || id);
  const directory = () => [
    ...users.map((user) => ({ id:`organization_user:${user.id}`, kind:'organization_user', assignee_id:user.id, name:user.name, status:'active', type_ids:user.access_role_ids, type_names:[], role_ids:user.access_role_ids, tag_ids:user.assignment_tag_ids || [], department_ids:[], branch_ids:['default'], traits:{ has_members:false, has_login:true, external_link:false, splits_pay:false }, link_status:'', fields:{ has_cdl:['u6', 'u27'].includes(user.id) }, fields_error:'', member_ids:[], member_count:0, members:[], group_ids:[] })),
    ...groups.filter((group) => group.status === 'active').map((group) => ({ id:`resource_group:${group.id}`, kind:'resource_group', assignee_id:group.id, name:group.name, status:'active', type_ids:[group.kind_id], type_names:typeNames([group.kind_id]), role_ids:[], tag_ids:group.assignment_tag_ids, department_ids:[], branch_ids:['default'], traits:{ has_members:true, has_login:false, external_link:false, splits_pay:true }, link_status:'', fields:{}, fields_error:'', member_ids:group.members.map((entry) => `organization_user:${entry.user_id}`), member_count:group.members.length, members:[], group_ids:[] })),
    ...connections.filter((company) => company.status === 'active').map((company) => ({ id:`organization_connection:${company.id}`, kind:'organization_connection', assignee_id:company.id, name:company.name, status:'active', type_ids:companyTypes[company.id] || [], type_names:typeNames(companyTypes[company.id] || []), role_ids:[], tag_ids:[], department_ids:[], branch_ids:['default'], traits:{ has_members:false, has_login:company.link_status === 'linked', external_link:true, splits_pay:false }, link_status:company.link_status, fields:{}, fields_error:'', member_ids:[], member_count:0, members:[], group_ids:[] }))
  ];
  Object.assign(window.__people, { groups, connections, types, companyTypes, staffing });
  const api = window.PlatformAPI;
  api.scopes = { list:async () => ({ templates:copy(scopes) }) };
  const terminology = {};
  let revision = 1;
  api.workforce.configuration = async () => ({ configuration:{ revision, terminology:copy(terminology), assignment_tags:copy(tags.filter((tag) => tag.status !== 'archived')), resource_group_kinds:copy(types.filter((type) => type.kind === 'resource_group')), organization_connection_types:copy(types.filter((type) => type.kind === 'organization_connection')) } });
  api.workforce.saveConfiguration = async (orgId, branchId, body) => {
    calls.push({ op:'saveConfiguration', body:copy(body) });
    const merge = (list, incoming) => { (incoming || []).forEach((entry) => { const held = list.find((item) => item.id === entry.id); if (held) Object.assign(held, entry); else list.push({ status:'active', ...entry }); }); };
    merge(tags, body.assignment_tags);
    (body.resource_group_kinds || []).forEach((entry) => { const type = types.find((item) => item.kind === 'resource_group' && item.id === entry.id); if (type) Object.assign(type, { name:entry.name, external_assignment:entry.external_assignment === true }); });
    if (body.terminology) Object.assign(terminology, body.terminology);
    revision += 1;
    return { configuration:{ revision } };
  };
  api.userActivity = { list:async (orgId, options) => { calls.push({ op:'activity', user:options?.user?.id }); return [{ type:'photo.uploaded', summary:'Uploaded 4 photos to 18 Maple Court', occurred_at:'2026-10-12T15:20:00Z' }, { type:'project.updated', summary:'Moved 22 Birch Lane to Scheduled', occurred_at:'2026-10-11T18:05:00Z' }, { type:'login', summary:'Signed in', occurred_at:'2026-10-10T15:00:00Z' }]; } };
  api.workforce.resourceGroups = async () => ({ resource_groups:copy(groups.filter((group) => group.status === 'active')) });
  api.workforce.createResourceGroup = async (orgId, branchId, body) => { const group = { id:`g${groups.length + 1}`, status:'active', revision:1, members:[], assignment_tag_ids:[], capability_scope_ids:[], ...body }; groups.push(group); calls.push({ op:'createResourceGroup', body:copy(body) }); return { resource_group:copy(group) }; };
  api.workforce.updateResourceGroup = async (orgId, branchId, id, patch) => {
    const group = groups.find((entry) => entry.id === id);
    const grants = [];
    if (patch.members) {
      const before = new Set(group.members.map((entry) => entry.user_id));
      const wanted = types.find((type) => type.id === group.kind_id)?.member_role_ids || [];
      group.members = patch.members.map((entry) => {
        const user = users.find((item) => item.id === entry.user_id);
        const added = before.has(entry.user_id) ? [] : wanted.filter((roleId) => !user.access_role_ids.includes(roleId));
        if (added.length) { user.access_role_ids = [...user.access_role_ids, ...added]; grants.push({ user_id:entry.user_id, role_ids:added, error:'' }); }
        return { ...entry, joined_role_ids:[...(group.members.find((old) => old.user_id === entry.user_id)?.joined_role_ids || []), ...added] };
      });
    }
    const { members, expected_revision, primary_member_user_id, ...rest } = patch;
    Object.assign(group, rest, { revision:group.revision + 1 });
    calls.push({ op:'updateResourceGroup', id, patch:copy(patch) });
    return { resource_group:copy(group), member_role_grants:grants };
  };
  api.workforce.archiveResourceGroup = async (orgId, branchId, id) => { groups.find((entry) => entry.id === id).status = 'archived'; calls.push({ op:'archiveResourceGroup', id }); return { ok:true, assignee_cleanup:[] }; };
  api.connections = {
    list:async () => ({ organization_connections:copy(connections.filter((company) => company.status === 'active')) }),
    create:async (orgId, body) => { const company = { id:`c${connections.length + 1}`, status:'active', revision:1, contacts:[], address:{}, metadata:{}, payment_terms:{}, link_status:'unlinked', ...body }; connections.push(company); calls.push({ op:'createConnection', body:copy(body) }); return { organization_connection:copy(company) }; },
    update:async (orgId, id, patch) => { const company = connections.find((entry) => entry.id === id); const { expected_revision, ...rest } = patch; Object.assign(company, rest, { revision:company.revision + 1 }); calls.push({ op:'updateConnection', id, patch:copy(patch) }); return { organization_connection:copy(company) }; },
    archive:async (orgId, id) => { connections.find((entry) => entry.id === id).status = 'archived'; calls.push({ op:'archiveConnection', id }); return { ok:true }; }
  };
  api.publication = {
    read:async (orgId, source) => {
      calls.push({ op:'read', source:`${source.provider}.${source.export}` });
      if (source.provider !== 'assignee-directory') return { status:'unavailable' };
      if (source.export === 'assignees') return { status:'ready', value:copy(directory()), revision:'r' };
      if (source.export === 'types') return { status:'ready', value:copy(types), revision:'r' };
      if (source.export === 'staffing-requirements') return { status:'ready', value:Object.entries(staffing).map(([id, list]) => ({ id:`resource_group:${id}`, assignee_id:`resource_group:${id}`, staffing_requirements:copy(list), revision:1 })), revision:'r' };
      return { status:'unavailable' };
    },
    invoke:async (orgId, action, target, input, options) => {
      calls.push({ op:'invoke', action, target:copy(target), input:copy(input), idempotencyKey:options?.idempotencyKey || '' });
      if (action === 'assignees.type.save') {
        let type = types.find((entry) => entry.id === input.id && entry.kind === input.kind);
        if (!type) { type = { id:input.id || input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), kind:input.kind, name:input.name, description:'', status:'active', member_role_ids:[] }; types.push(type); }
        Object.assign(type, { name:input.name }, input.description !== undefined ? { description:input.description } : {}, input.status ? { status:input.status } : {});
        return { value:copy(type) };
      }
      if (action === 'assignees.type.member-roles.set') { const type = types.find((entry) => entry.id === input.id); type.member_role_ids = input.member_role_ids; return { value:copy(type) }; }
      if (action === 'assignees.profile.set') { if (input.assignee.type === 'organization_connection' && input.type_ids) companyTypes[input.assignee.id] = input.type_ids; return { value:{ assignee:input.assignee, id:`${input.assignee.type}:${input.assignee.id}`, name:'', type_ids:input.type_ids || [], tag_ids:input.tag_ids || [] } }; }
      if (action === 'assignees.staffing-requirements.set') { staffing[input.assignee.id] = copy(input.staffing_requirements); return { value:{ assignee:input.assignee, staffing_requirements:copy(input.staffing_requirements), revision:2 } }; }
      if (action === 'payroll.contractor.company.update') { connections.find((entry) => entry.id === target.id).payment_terms = input.payment_terms; return { value:{ ok:true } }; }
      throw new Error(`Unknown action ${action}`);
    }
  };
}

// The part of the real shell that hoists a category's sub-tabs to the top right (company.js syncSettingsSubtabs).
function hoistSubtabs(){
  const slot = document.querySelector('[data-settings-subtabs-slot]');
  const layout = document.querySelector('.cs-layout');
  const card = document.querySelector('.cs-card');
  let queued = false;
  const sync = () => {
    queued = false;
    const source = document.querySelector('[data-settings-pane].active .fm-settings-subtabs');
    if (!source) { slot.replaceChildren(); slot.hidden = true; layout.classList.add('no-subtabs'); return; }
    const buttons = Array.from(source.querySelectorAll('button'));
    const proxy = source.cloneNode(true);
    source.dataset.settingsSubtabsSource = 'true';
    proxy.removeAttribute('data-settings-subtabs-source');
    proxy.dataset.settingsSubtabsProxy = 'true';
    Array.from(proxy.querySelectorAll('button')).forEach((button, index) => button.addEventListener('click', (event) => { event.preventDefault(); buttons[index]?.click(); }));
    slot.replaceChildren(proxy);
    slot.hidden = false;
    layout.classList.remove('no-subtabs');
  };
  new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(sync); } }).observe(card, { childList:true, subtree:true, attributes:true, attributeFilter:['class', 'aria-selected'] });
  sync();
}

async function openPage(browser, viewport, options = {}){
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|net::ERR/.test(message.text())) errors.push(message.text()); });
  await page.route('http://people.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/libraries/')) return route.fulfill({ contentType:'application/javascript', body:await readFile(new URL(pathname.slice('/libraries/'.length), libraries)) });
    return route.fulfill({ contentType:'text/html', body:SHELL });
  });
  await page.goto('http://people.test/');
  await page.evaluate(stubPlatform);
  await page.evaluate(stubDirectory);
  if (options.flags) await page.evaluate((flags) => Object.assign(window.__people.flags, flags), options.flags);
  if (options.setup) await page.evaluate(options.setup);
  await page.addScriptTag({ url:'http://people.test/libraries/platform-ui/platform-ui.js' });
  await page.addScriptTag({ url:'http://people.test/libraries/settings-pages/firstmate-settings-pages.js' });
  for (const file of FILES) await page.addScriptTag({ url:`http://people.test/libraries/apps/people/${file}.js` });
  await page.evaluate(hoistSubtabs);
  // The shell activates the pane; People mounts itself into it.
  await page.evaluate(() => document.getElementById('csPanePeople').classList.add('active'));
  await page.locator('.pp-card').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.pp-card.loading'));
  if (options.view !== 'home') await openView(page, options.view || 'users');
  return { page, errors };
}
const openView = async (page, view) => { await page.locator('[data-settings-subtabs-proxy] button').nth(TABS.indexOf(view)).evaluate((button) => { button.scrollIntoView({ inline:'center', block:'nearest' }); button.click(); }); if (view !== 'home') await page.locator('.pp-list-body[aria-busy="false"]').first().waitFor(); };
const shot = async (page, name) => { if (!shots) return; await mkdir(shots, { recursive:true }); await page.waitForTimeout(260); await page.screenshot({ path:path.join(shots, `${name}.png`) }); };
const columnsOf = (page, selector) => page.evaluate((sel) => new Set(Array.from(document.querySelectorAll(sel)).map((row) => Math.round(row.getBoundingClientRect().left))).size, selector);
const launch = () => chromium.launch({ executablePath:process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), headless:true });

test('People category: Users list, hover card, user and role modals, invitations', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 });

    // Header: icon, one title, the count in English, search and buttons on one line, no refresh button.
    assert.equal(await page.locator('.pp-list-head h2').innerText(), 'Users');
    assert.equal(await page.locator('.pp-list-sub').innerText(), '42 users, 3 never signed in, 1 suspended');
    assert.equal(await page.locator('.pp-list-heading > i').count(), 1);
    assert.deepEqual(await page.locator('.pp-list-tools .pp-btn').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Roles', 'Invite user']);
    assert.equal(await page.locator('.pp-list-head [aria-label*="efresh"]').count(), 0);
    const headBoxes = await page.evaluate(() => ['.pp-search input', '[data-list-action="0"]', '[data-list-action="1"]'].map((selector) => Math.round(document.querySelector(selector).getBoundingClientRect().top + document.querySelector(selector).getBoundingClientRect().height / 2)));
    assert.ok(Math.max(...headBoxes) - Math.min(...headBoxes) <= 1, 'search and buttons share one line');

    // The category's sub-pages are the shared bubble tabs, hoisted by the shell; groups are named by terminology.
    assert.deepEqual(await page.locator('[data-settings-subtabs-proxy] button').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Overview', 'Users', 'Groups', 'Departments', 'Subcontractors']);

    // Rows: two columns of tight rows.
    assert.equal(await page.locator('.pp-row').count(), 42);
    assert.equal(await columnsOf(page, '.pp-row'), 2);
    assert.ok(await page.locator('.pp-row').first().evaluate((row) => row.getBoundingClientRect().height) <= 48);
    assert.equal(await page.locator('.pp-row .pp-pill.warn').count(), 3);
    assert.equal(await page.locator('.pp-row .pp-pill.warn').first().innerText(), 'Never signed in');
    assert.equal(await page.locator('.pp-row.dimmed .pp-pill.danger').innerText(), 'Suspended');
    const manyRoles = page.locator('[data-row-key="u9"]');
    assert.equal(await manyRoles.locator('.pp-chip.role.more').innerText().then((text) => /^\+\d$/.test(text)), true);
    assert.ok(await manyRoles.evaluate((row) => row.scrollWidth <= row.clientWidth + 1), 'a row with many roles and departments does not overflow');
    assert.ok(await page.locator('[data-row-key="u8"]').evaluate((row) => row.scrollWidth <= row.clientWidth + 1), 'a long name truncates');

    // Presence arrives on the platform channel and lights the dot.
    assert.equal(await page.locator('[data-row-key="u2"] .pp-online').isHidden(), true);
    await page.evaluate(() => window.__people.presence([{ user_id:'u2', status:'active' }, { user_id:'u3', status:'away' }, { user_id:'u9', status:'active' }, { user_id:'u14', status:'active' }, { user_id:'u21', status:'active' }]));
    assert.equal(await page.locator('[data-row-key="u2"] .pp-online').isVisible(), true);
    assert.equal(await page.locator('[data-row-key="u3"] .pp-online').getAttribute('data-status'), 'away');
    assert.equal(await page.locator('[data-row-key="u5"] .pp-online').isHidden(), true);
    await shot(page, 'users-desktop');

    // Search.
    await page.locator('[data-list-search]').fill('foreman');
    await page.waitForFunction(() => document.querySelectorAll('.pp-row').length < 42);
    assert.match(await page.locator('.pp-list-sub').innerText(), /^\d+ of 42 users/);
    await page.locator('[data-list-search]').fill('zzzz');
    await page.locator('.pp-list-state').waitFor();
    await shot(page, 'users-empty-search');
    await page.locator('[data-list-search]').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.pp-row').length === 42);

    // Hover card: opens after a short delay, is read-only and never focusable.
    await page.locator('[data-row-key="u9"] .pp-row-name').hover();
    await page.locator('.pp-hover.open').waitFor();
    assert.match(await page.locator('.pp-hover').innerText(), /northwind-exteriors\.example/);
    assert.equal(await page.locator('.pp-hover').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('.pp-hover').locator('a,button,input,[tabindex]').count(), 0);
    assert.match(await page.locator('.pp-hover [data-section="groups"]').innerText(), /North team/);
    await shot(page, 'hover-card');
    await page.mouse.move(700, 5);
    await page.waitForFunction(() => !document.querySelector('.pp-hover.open'));

    // Quick actions are inline on the row.
    await page.locator('[data-row-key="u5"]').hover();
    assert.deepEqual(await page.locator('[data-row-key="u5"] .pp-row-actions button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))), ['Edit', 'Resend invitation', 'Suspend', 'Delete']);
    await shot(page, 'row-quick-actions');
    await page.locator('[data-row-key="u5"] [data-row-action="invite"]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'resendInvite' && call.id === 'u5'));

    // Open a user: the large modal, summary left, tabs right.
    await page.locator('[data-row-key="u3"] .pp-row-name').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.deepEqual(await dialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim().replace(/\s+\d+$/, ''))), ['Permissions', 'App experience', 'Compensation', 'Fields', 'Activity']);
    assert.ok(await page.evaluate(() => document.querySelector('.pp-modal').contains(document.activeElement)), 'focus moves into the modal');
    assert.match(await dialog.locator('[data-section="roles"]').innerText(), /Sales/);
    assert.match(await dialog.locator('[data-section="departments"]').innerText(), /Service and warranty[\s\S]*Sales/);
    assert.match(await dialog.locator('[data-section="groups"]').innerText(), /Closers/);
    assert.equal(await dialog.locator('[data-section="groups"] button').count(), 0, 'group membership is not edited on the user');
    assert.equal(await dialog.locator('.pp-modal-panel:not([hidden])').evaluate((panel) => panel.scrollHeight <= panel.clientHeight + 1), true, 'the permissions tab fits without scrolling');

    // Permissions: inherited from roles, overridden on the user.
    await dialog.locator('[data-perm-group="sales"]').click();
    const followups = dialog.locator('[data-perm-key="sales.followups.manage"]');
    assert.match(await followups.getAttribute('class'), /allowed/);
    assert.doesNotMatch(await followups.getAttribute('class'), /overridden/);
    assert.equal(await followups.locator('[data-choice="inherit"]').getAttribute('aria-checked'), 'true');
    const earnings = dialog.locator('[data-perm-key="sales.earnings.view"]');
    assert.match(await earnings.getAttribute('class'), /overridden/);
    assert.match(await earnings.getAttribute('class'), /denied/);
    assert.equal(await dialog.locator('[data-modal-tab="permissions"] [data-tab-badge]').innerText(), '1');
    await shot(page, 'user-modal-permissions');
    await followups.locator('[data-choice="deny"]').click();
    assert.match(await dialog.locator('[data-perm-key="sales.followups.manage"]').getAttribute('class'), /overridden/);
    assert.equal(await dialog.locator('[data-modal-tab="permissions"] [data-tab-badge]').innerText(), '2');
    assert.equal(await dialog.locator('[data-modal-save]').isEnabled(), true);
    await dialog.locator('[data-perm-filter="overrides"]').click();
    assert.equal(await dialog.locator('.pp-perm-row').count(), 2);
    await dialog.locator('[data-perm-filter="all"]').click();

    // Changing a role changes what is inherited.
    await dialog.locator('[data-perm-group="crew"]').click();
    assert.doesNotMatch(await dialog.locator('[data-perm-key="crew.time_clock.use"]').getAttribute('class'), /allowed/);
    await dialog.locator('[data-people-section-action="roles"]').click();
    await page.getByRole('menuitemcheckbox', { name:'Foreman' }).click();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true, 'Escape closes the menu, not the modal');
    assert.match(await dialog.locator('[data-section="roles"]').innerText(), /Foreman/);
    assert.match(await dialog.locator('[data-perm-key="crew.time_clock.use"]').getAttribute('class'), /allowed/);
    assert.doesNotMatch(await dialog.locator('[data-perm-key="crew.time_clock.use"]').getAttribute('class'), /overridden/);

    // App experience is a grid of tabs by platform.
    await dialog.getByRole('tab', { name:'App experience' }).click();
    assert.ok(await columnsOf(page, '.pp-app') >= 2, 'tabs are laid out as a grid');
    const payroll = dialog.locator('[data-apps-id="portal.payroll"]');
    assert.equal(await payroll.locator('[data-apps-cell="desktop"]').getAttribute('aria-pressed'), 'false', 'the Sales role hides Payroll');
    assert.equal(await payroll.locator('.pp-app-cell.absent').count(), 1, 'Payroll does not exist on the phone');
    const calls = dialog.locator('[data-apps-id="portal.calls"]');
    assert.equal(await calls.locator('[data-apps-cell="mobile"]').getAttribute('aria-pressed'), 'true');
    await calls.locator('[data-apps-cell="mobile"]').click();
    assert.match(await dialog.locator('[data-apps-id="portal.calls"]').getAttribute('class'), /overridden/);
    assert.equal(await dialog.locator('[data-apps-id="portal.calls"] [data-apps-cell="desktop"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await dialog.locator('.pp-modal-panel:not([hidden]) .pp-apps-grid').evaluate((grid) => grid.scrollHeight <= grid.clientHeight + 1), true, 'the grid fits without scrolling');
    await shot(page, 'user-modal-app-experience');

    // Compensation and Fields are slots with a mount contract.
    await dialog.getByRole('tab', { name:'Compensation' }).click();
    await dialog.locator('[data-people-slot-empty="compensation"]').waitFor();
    await shot(page, 'user-modal-slot-placeholder');
    await page.evaluate(() => window.FirstMatePeople.slots.register('compensation', { kinds:['organization_user'], mount(container, context){ window.__people.slot = { entity:context.entity, orgId:context.orgId, readOnly:context.readOnly }; container.innerHTML = '<button id="slotDirty">Pay sheet</button>'; container.firstChild.onclick = () => context.onDirty(true); return { save:async () => { window.__people.slotSaved = true; } }; } }));
    await dialog.locator('#slotDirty').click();
    assert.deepEqual(await page.evaluate(() => window.__people.slot), { entity:{ kind:'organization_user', id:'u3', key:'organization_user:u3', name:'Carla Farouk', traits:{ has_members:false, has_login:true, external_link:false, splits_pay:false } }, orgId:'org', readOnly:false });
    await dialog.getByRole('tab', { name:'Fields' }).click();
    await dialog.locator('[data-people-slot-empty="fields"]').waitFor();

    // Focus stays inside the modal.
    for (let index = 0; index < 40; index += 1) await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.querySelector('.pp-modal-back').contains(document.activeElement)), 'focus is trapped');

    // Save writes roles and overrides to the user.
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    const saved = await page.evaluate(() => ({ profile:window.__people.calls.filter((call) => call.op === 'saveUserProfile' && call.id === 'u3').pop().profile, slot:window.__people.slotSaved }));
    assert.deepEqual([...saved.profile.access_role_ids].sort(), ['crew_foreman', 'sales']);
    assert.deepEqual(saved.profile.permission_overrides, { 'sales.earnings.view':false, 'sales.followups.manage':false });
    assert.deepEqual(saved.profile.app_access_overrides, { 'portal.calls':'hide' });
    assert.equal(saved.profile.application_access.field.enabled, true);
    assert.equal(saved.slot, true);

    // Unsaved changes are confirmed; Escape closes and focus returns to the row.
    await dialog.getByRole('tab', { name:'Permissions' }).click();
    await dialog.locator('[data-perm-group="general"]').click();
    await dialog.locator('[data-perm-key="manage_billing"] [data-choice="allow"]').click();
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor();
    await page.getByRole('button', { name:'Discard' }).click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.pp-row')?.dataset.rowKey), 'u3');
    assert.match(await page.locator('[data-row-key="u3"]').innerText(), /Foreman/);

    // Roles: the header button drops a menu; a role opens in the same modal.
    await page.locator('[data-list-action="0"]').click();
    await page.getByRole('menu', { name:'Roles' }).waitFor();
    await shot(page, 'roles-menu');
    await page.getByRole('menuitem', { name:/^Sales/ }).click();
    const roleDialog = page.getByRole('dialog', { name:'Sales' });
    await roleDialog.waitFor();
    assert.deepEqual(await roleDialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Permissions', 'Members', 'App experience', 'Compensation', 'Fields']);
    await roleDialog.locator('[data-perm-group="sales"]').click();
    assert.equal(await roleDialog.locator('[data-perm-key="sales.earnings.view"] [role="switch"]').getAttribute('aria-checked'), 'true');
    await roleDialog.locator('[data-perm-key="sales.stats.view_team"] [role="switch"]').click();
    await shot(page, 'role-modal-permissions');
    await roleDialog.getByRole('tab', { name:'Members' }).click();
    await roleDialog.locator('.pp-members .pp-row').first().waitFor();
    assert.match(await roleDialog.locator('.pp-members .pp-list-sub').innerText(), /^\d+ members$/);
    assert.ok(await roleDialog.locator('.pp-members .pp-row').count() >= 8);
    await shot(page, 'role-modal-members');
    await roleDialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'updateAccessRole'));
    const rolePatch = await page.evaluate(() => window.__people.calls.find((call) => call.op === 'updateAccessRole').patch);
    assert.equal(rolePatch.permissions['sales.stats.view_team'], true);
    assert.equal(rolePatch.expected_revision, 5);
    await roleDialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    // Invitations live here.
    await page.locator('[data-list-action="1"]').click();
    const invite = page.locator('.pp-form');
    await invite.waitFor();
    await invite.locator('[type="submit"]').click();
    assert.equal(await invite.locator('.pp-form-error').innerText(), 'Email is required');
    await invite.locator('[name="name"]').fill('Nadia Petrov');
    await invite.locator('[name="email"]').fill('nadia@northwind-exteriors.example');
    await invite.getByRole('button', { name:'Sales', exact:true }).click();
    await shot(page, 'invite-user');
    await invite.locator('[type="submit"]').click();
    await page.locator('[data-row-key="u43"]').waitFor();
    const created = await page.evaluate(() => window.__people.calls.find((call) => call.op === 'create').data);
    assert.equal(created.email, 'nadia@northwind-exteriors.example');
    assert.equal(created.status, 'invited');
    assert.ok(created.access_role_ids.includes('sales'));
    assert.equal(await page.locator('.pp-list-sub').innerText(), '43 users, 4 never signed in, 1 suspended');
    assert.equal(await page.locator('[data-row-key="u43"] .pp-pill.warn').innerText(), 'Never signed in');

    // Suspend and delete from the row.
    await page.locator('[data-row-key="u20"]').hover();
    await page.locator('[data-row-key="u20"] [data-row-action="suspend"]').click();
    await page.locator('[data-row-key="u20"].dimmed').waitFor();
    assert.equal(await page.locator('[data-row-key="u20"] .pp-pill.danger').innerText(), 'Suspended');
    assert.equal(await page.locator('.pp-list-sub').innerText(), '43 users, 4 never signed in, 2 suspended');
    assert.equal(await page.locator('[data-row-key="u1"] [data-row-action="suspend"]').isDisabled(), true, 'you cannot suspend yourself');
    await page.locator('[data-row-key="u21"]').hover();
    await page.locator('[data-row-key="u21"] [data-row-action="delete"]').click();
    await page.getByRole('alertdialog').getByRole('button', { name:'Delete' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-row-key="u21"]'));

    // Sub-pages are routed.
    await openView(page, 'groups');
    assert.ok(await page.evaluate(() => window.__people.routes.some((route) => route.sub === 'people' && route.settingsView === 'groups')));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('People category at phone width: one column of rows and a full-screen modal with the summary on top', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:390, height:844 });
    assert.equal(await columnsOf(page, '.pp-row'), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scrolling');
    assert.equal(await page.locator('.pp-list-sub').innerText(), '42 users, 3 never signed in, 1 suspended');
    await page.evaluate(() => window.__people.presence([{ user_id:'u2', status:'active' }, { user_id:'u9', status:'active' }]));
    await shot(page, 'users-phone');
    await page.locator('[data-row-key="u9"] .pp-row-name').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.waitForTimeout(260);
    const box = await page.locator('.pp-modal').boundingBox();
    assert.deepEqual([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)], [0, 0, 390, 844]);
    const summaryBottom = await page.locator('.pp-modal-summary').evaluate((element) => element.getBoundingClientRect().bottom);
    const tabsTop = await page.locator('.pp-tabs').evaluate((element) => element.getBoundingClientRect().top);
    assert.ok(summaryBottom <= tabsTop + 1, 'the summary sits above the tabs');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(page, 'user-modal-phone');
    await page.locator('[data-modal-summary-toggle]').click();
    await dialog.locator('[data-section="roles"]').waitFor();
    await shot(page, 'user-modal-phone-details');
    await page.locator('[data-modal-summary-toggle]').click();
    await dialog.getByRole('tab', { name:'App experience' }).click();
    await shot(page, 'user-modal-phone-apps');
    await page.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('People list shows a loading skeleton and a retryable error', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport:{ width:1100, height:700 } });
    await page.route('http://people.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/libraries/')) return route.fulfill({ contentType:'application/javascript', body:await readFile(new URL(pathname.slice('/libraries/'.length), libraries)) });
      return route.fulfill({ contentType:'text/html', body:SHELL });
    });
    await page.goto('http://people.test/');
    await page.evaluate(stubPlatform);
    await page.evaluate(stubDirectory);
    await page.evaluate(() => { window.__people.route.settingsView = 'users'; });
    await page.evaluate(() => { const list = window.PlatformAPI.users.list; let failed = false; window.PlatformAPI.users.list = async () => { await new Promise((resolve) => setTimeout(resolve, 500)); if (!failed) { failed = true; throw new Error('The people service did not answer.'); } return list(); }; });
    await page.addScriptTag({ url:'http://people.test/libraries/settings-pages/firstmate-settings-pages.js' });
    for (const file of FILES) await page.addScriptTag({ url:`http://people.test/libraries/apps/people/${file}.js` });
    await page.evaluate(() => document.getElementById('csPanePeople').classList.add('active'));
    await page.locator('.pp-skeleton').first().waitFor();
    assert.equal(await page.locator('.pp-list-body').getAttribute('aria-busy'), 'true');
    await shot(page, 'users-loading');
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /did not answer/);
    await shot(page, 'users-error');
    await page.getByRole('button', { name:'Try again' }).click();
    await page.locator('.pp-row').first().waitFor();
  } finally { await browser.close(); }
});

test('People overview: four cards with live counts that open their pages', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'home' });
    const cards = await page.locator('.pp-card').evaluateAll((nodes) => nodes.map((node) => [node.querySelector('strong').textContent, node.querySelector('b').textContent]));
    assert.deepEqual(cards, [['Users', '42'], ['User Groups', '5'], ['Departments', '5'], ['Subcontractors', '4']]);
    assert.match(await page.locator('[data-home-card="users"]').innerText(), /3 never signed in/);
    assert.match(await page.locator('[data-home-card="subcontractors"]').innerText(), /1 linked/);
    await shot(page, 'home-desktop');
    await page.locator('[data-home-card="departments"]').click();
    await page.locator('.pp-list-head h2', { hasText:'Departments' }).waitFor();
    assert.ok(await page.evaluate(() => window.__people.routes.some((route) => route.settingsView === 'departments')));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Groups: rows, types with roles on joining, members and what joining gave, staffing requirements', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'groups' });
    assert.equal(await page.locator('.pp-list-head h2').innerText(), 'User Groups');
    assert.match(await page.locator('.pp-list-sub').innerText(), /^5 groups, \d+ people in one$/);
    assert.deepEqual(await page.locator('.pp-list-tools .pp-btn').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Types', 'Tags', 'New group']);
    const north = page.locator('[data-row-key="g1"]');
    // Groups sit under their type's section, and the row does not repeat the type.
    assert.deepEqual(await page.locator('.pp-list-section-head h3').allInnerTexts(), ['Install crews', 'Sales teams', 'Service teams']);
    assert.equal(await page.locator('.pp-list-section').first().locator('[data-row-key="g1"]').count(), 1);
    assert.equal(await north.locator('.pp-pill').count(), 0);
    assert.equal(await north.locator('.pp-stack-count').innerText(), '7');
    assert.equal(await north.locator('.pp-stack .pp-avatar').count(), 4);
    assert.match(await north.locator('.pp-row-chips').innerText(), /Production/);
    assert.ok(await page.locator('[data-row-key="g4"]').evaluate((row) => row.scrollWidth <= row.clientWidth + 1 && row.getBoundingClientRect().height <= 48), 'a long group name stays on one tight row');
    assert.equal(await page.locator('.pp-row').evaluateAll((rows) => rows.every((row) => row.getBoundingClientRect().height <= 48)), true);
    await shot(page, 'groups-desktop');
    await north.locator('.pp-row-name').hover();
    await page.locator('.pp-hover.open').waitFor();
    assert.match(await page.locator('.pp-hover').innerText(), /North team[\s\S]*Install crew[\s\S]*Members\s*7/);
    await page.mouse.move(700, 5);

    // Types: a list in the same pattern as every other People list; a type opens in the modal a role opens in.
    await page.locator('[data-list-action="0"]').click();
    const typesDialog = page.getByRole('dialog', { name:'Group types' });
    await typesDialog.waitFor();
    assert.equal(await typesDialog.locator('.pp-type').count(), 3);
    assert.match(await typesDialog.locator('[data-type-id="crew"]').innerText(), /Install crew[\s\S]*Installer/);
    assert.equal(await typesDialog.locator('[data-type-id="crew"] .pp-type-open').getAttribute('data-fm-tooltip'), 'Works a job together in the field');
    assert.match(await typesDialog.locator('.pp-info').getAttribute('aria-label'), /Nothing is removed when they leave/);
    assert.equal(await typesDialog.locator('[data-type-id="crew"] [data-list-row-action="archive"]').isDisabled(), true, 'a type in use cannot be archived');
    await shot(page, 'group-types');
    await typesDialog.locator('[data-type-id="crew"] .pp-type-open').click();
    const typeDialog = page.getByRole('dialog', { name:'Install crew' });
    await typeDialog.waitFor();
    assert.deepEqual(await typeDialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Groups', 'Compensation', 'Fields']);
    assert.match(await typeDialog.locator('.pp-modal-summary').innerText(), /Install crew[\s\S]*Works a job together[\s\S]*Roles on joining[\s\S]*Installer[\s\S]*Open to partners/i);
    assert.equal(await typeDialog.locator('.pp-members .pp-row').count(), 2, 'the groups of this type are listed');
    await typeDialog.locator('[data-people-section-action="roles"]').click();
    await page.getByRole('menuitemcheckbox', { name:'Foreman' }).click();
    await page.keyboard.press('Escape');
    assert.equal(await typeDialog.locator('[data-type-external]').getAttribute('aria-checked'), 'false');
    await typeDialog.locator('[data-type-external]').click();
    await shot(page, 'group-type-modal');
    await typeDialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'saveConfiguration'));
    assert.deepEqual(await page.evaluate(() => window.__people.calls.find((call) => call.action === 'assignees.type.member-roles.set').input), { id:'crew', member_role_ids:['crew_member', 'crew_foreman'] });
    const flagged = await page.evaluate(() => window.__people.calls.find((call) => call.op === 'saveConfiguration').body);
    assert.deepEqual(flagged.resource_group_kinds, [{ id:'crew', name:'Install crew', description:'Works a job together in the field', status:'active', external_assignment:true }]);
    assert.equal(flagged.expected_revision, 1);
    // The panels are told this is a home for everything of the type.
    await typeDialog.locator('.pp-tab', { hasText:'Fields' }).click();
    await page.evaluate(() => window.FirstMatePeople.slots.register('fields', { kinds:['resource_group_kind'], mount(container, context){ window.__people.typeSlot = context.entity; container.textContent = 'Type fields'; } }));
    assert.deepEqual(await page.evaluate(() => window.__people.typeSlot), { kind:'resource_group_kind', id:'crew', key:'resource_group_kind:crew', name:'Install crew', home:{ kind:'group_type', id:'crew' } });
    await typeDialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    await page.locator('[data-list-action="0"]').click();
    await typesDialog.locator('[data-type-id="crew"]').getByText('Open to partners').waitFor();
    await typesDialog.locator('[data-list-new]').click();
    await page.locator('.pp-form [name="name"]').fill('Gutter crew');
    await page.locator('.pp-form [type="submit"]').click();
    await page.getByRole('dialog', { name:'Gutter crew' }).waitFor();
    assert.equal(await page.evaluate(() => window.__people.calls.find((call) => call.action === 'assignees.type.save').input.kind), 'resource_group');
    assert.ok(await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'invoke').every((call) => call.idempotencyKey && call.target.scope === 'organization')));
    await page.getByRole('dialog', { name:'Gutter crew' }).locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    // A group: summary on the left without the member list the tab shows; tabs by trait.
    await north.locator('.pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'North team' });
    await dialog.waitFor();
    assert.deepEqual(await dialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim().replace(/\s+\d+$/, ''))), ['Members', 'Staffing requirements', 'Compensation', 'Fields']);
    assert.doesNotMatch(await dialog.locator('.pp-modal-summary').innerText(), /Members/);
    assert.match(await dialog.locator('.pp-modal-summary').innerText(), /Install crew[\s\S]*Lead[\s\S]*Production[\s\S]*Shingle[\s\S]*Roofing/i);
    assert.match(await dialog.locator('.pp-members .pp-list-sub').innerText(), /^7 members$/);
    assert.equal(await dialog.locator('.pp-members [data-row-key="u6"] .pp-pill').innerText(), 'Lead');
    assert.match(await dialog.locator('.pp-members [data-row-key="u7"] .pp-row-chips').innerText(), /Installer/, 'a role given on joining is shown on the member');
    await shot(page, 'group-modal-members');

    // Adding a member gives the type's roles, and the page says which.
    await dialog.locator('.pp-members [data-list-action="1"]').click();
    await page.locator('.pp-menu-search input').fill('Ana Lopez');
    await page.getByRole('menuitemcheckbox', { name:'Ana Lopez' }).click();
    await dialog.locator('.pp-members [data-row-key="u1"]').waitFor();
    await page.keyboard.press('Escape');
    assert.match(await dialog.locator('.pp-members [data-row-key="u1"] .pp-row-chips').innerText(), /Installer[\s\S]*Foreman|Foreman[\s\S]*Installer/);
    const toast = await page.evaluate(() => window.__people.toasts.find((entry) => /was given/.test(entry.title)));
    assert.match(toast.title, /Ana Lopez was given Installer, Foreman/);
    assert.match(toast.message, /They stay if the person leaves/);
    await shot(page, 'group-modal-member-joined');
    await dialog.locator('.pp-members [data-row-key="u8"]').hover();
    await dialog.locator('.pp-members [data-row-key="u8"] [data-row-action="remove"]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-members [data-row-key="u8"]'));

    // The type is one, from a dropdown.
    await dialog.locator('[data-people-identity]').click();
    assert.equal(await dialog.locator('select[data-identity="typeId"]').evaluate((select) => select.multiple), false);
    assert.deepEqual(await dialog.locator('select[data-identity="typeId"] option').allInnerTexts(), ['Gutter crew', 'Install crew', 'Sales team', 'Service team']);

    // Staffing requirements: a count and a condition; they warn and never block.
    await dialog.getByRole('tab', { name:/Staffing requirements/ }).click();
    assert.match(await dialog.locator('.pp-modal-panel:not([hidden]) .pp-info').getAttribute('aria-label'), /warning[\s\S]*never blocks/);
    assert.equal(await dialog.locator('.pp-req').count(), 1);
    assert.equal(await dialog.locator('.pp-req [data-req-label]').inputValue(), 'CDL driver');
    assert.equal(await dialog.locator('.pp-req [data-rule-field]').inputValue(), 'fields.has_cdl');
    await dialog.locator('[data-req-new]').click();
    const added = dialog.locator('.pp-req').nth(1);
    await added.locator('[data-req-label]').fill('Foreman');
    await added.locator('[data-req-count]').fill('1');
    await added.locator('[data-rule-value]').selectOption('crew_foreman');
    await shot(page, 'group-modal-staffing');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.action === 'assignees.staffing-requirements.set'));
    const staffing = await page.evaluate(() => window.__people.calls.find((call) => call.action === 'assignees.staffing-requirements.set').input);
    assert.deepEqual(staffing.assignee, { type:'resource_group', id:'g1' });
    assert.deepEqual(staffing.staffing_requirements[1].where, { rules:[{ field:'type_ids', operator:'contains', value:'crew_foreman' }] });
    assert.equal(staffing.staffing_requirements[1].count, 1);
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    // New group: a name and one type.
    await page.locator('[data-list-action="2"]').click();
    await page.locator('.pp-form [name="name"]').fill('East team');
    await page.locator('.pp-form [name="typeId"]').selectOption('crew');
    await shot(page, 'group-new');
    await page.locator('.pp-form [type="submit"]').click();
    await page.getByRole('dialog', { name:'East team' }).waitFor();
    assert.deepEqual(await page.evaluate(() => { const body = window.__people.calls.find((call) => call.op === 'createResourceGroup').body; return [body.name, body.kind_id]; }), ['East team', 'crew']);
    await page.locator('.pp-members .pp-list-state').waitFor();
    await shot(page, 'group-modal-empty');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Departments: icon and color, members of every kind, roles held only here, a Fields slot', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'departments' });
    assert.equal(await page.locator('.pp-list-head h2').innerText(), 'Departments');
    assert.match(await page.locator('.pp-list-sub').innerText(), /^5 departments/);
    const production = page.locator('.pp-list-body [data-row-key="production"]');
    assert.ok(await production.locator('.pp-avatar i.fa-helmet-safety').count(), 'the row shows the department icon');
    assert.ok(Number(await production.locator('.pp-stack-count').innerText()) > 5);
    await shot(page, 'departments-desktop');

    await production.locator('.pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'Production' });
    await dialog.waitFor();
    assert.deepEqual(await dialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Members', 'App visibility', 'Roles here only', 'Fields']);
    assert.match(await dialog.locator('.pp-modal-summary').innerText(), /Production[\s\S]*Roles[\s\S]*Foreman[\s\S]*Install crew/i);
    await dialog.locator('.pp-members .pp-row').first().waitFor();
    await shot(page, 'department-modal-members');

    // Icon picker.
    await dialog.locator('[data-people-photo]').click();
    await page.locator('.pp-picker').waitFor();
    await page.locator('[data-pick-icon="fa-hammer"]').click();
    await page.locator('[data-pick-color="#ea580c"]').click();
    await shot(page, 'department-icon-picker');
    await page.keyboard.press('Escape');
    assert.ok(await dialog.locator('.pp-sum-photo i.fa-hammer').count());

    // Members: add a user directly; groups come through their type.
    await dialog.locator('.pp-members [data-list-action="0"]').click();
    await page.locator('.pp-menu-search input').fill('Ben Bernard');
    await page.getByRole('menuitemcheckbox', { name:'Ben Bernard' }).click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'saveDepartmentAssignment' && call.payload.kind === 'user' && call.payload.department_ids.includes('production')));
    await page.keyboard.press('Escape');
    await dialog.locator('[data-dept-kind="groups"]').click();
    await dialog.locator('[data-dept-list] [data-row-key="g1"]').waitFor();
    assert.match(await dialog.locator('[data-dept-list] [data-row-key="g1"]').innerText(), /North team[\s\S]*through its type/);
    await shot(page, 'department-modal-groups');

    // Roles held only in this department are saved on the user.
    await dialog.locator('.pp-tab', { hasText:'Roles here only' }).click();
    await dialog.locator('.pp-modal-panel:not([hidden]) [data-list-action="0"]').click();
    await page.locator('.pp-form [name="userId"]').selectOption('u6');
    assert.equal(await page.locator('.pp-form [name="roleId"] option', { hasText:'Administrator' }).count(), 0, 'roles that administer the organization cannot be scoped');
    await page.locator('.pp-form [name="roleId"]').selectOption('production');
    await page.locator('.pp-form [type="submit"]').click();
    await dialog.locator('.pp-modal-panel:not([hidden]) [data-row-key="u6"]').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveUserProfile' && call.id === 'u6').pop().profile.scoped_access_assignments), [{ role_id:'production', scope:{ kind:'department', id:'production' } }]);
    await shot(page, 'department-modal-scoped-roles');
    await dialog.locator('.pp-tab', { hasText:'Fields' }).click();
    await dialog.locator('[data-people-slot-empty="fields"]').waitFor();
    await page.evaluate(() => window.FirstMatePeople.slots.register('fields', { kinds:['department'], mount(container, context){ window.__people.fieldSlot = context.entity; container.textContent = 'Department fields'; } }));
    assert.deepEqual(await page.evaluate(() => window.__people.fieldSlot), { kind:'department', id:'production', key:'department:production', name:'Production', home:{ kind:'department', id:'production' } });

    // Save writes the icon and color into the catalog and keeps everything else.
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'saveDepartments'));
    const saved = await page.evaluate(() => window.__people.calls.find((call) => call.op === 'saveDepartments').payload);
    const row = saved.departments.find((department) => department.id === 'production');
    assert.equal(row.icon, 'fa-hammer');
    assert.equal(row.color, '#ea580c');
    assert.deepEqual(row.role_ids, ['production', 'crew_foreman', 'crew_member']);
    assert.equal(saved.departments.length, 5);
    assert.equal(saved.revision, 4);
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    assert.ok(await page.locator('.pp-list-body [data-row-key="production"] .pp-avatar i.fa-hammer').count());

    await page.locator('[data-list-action="2"]').click();
    await page.locator('.pp-form [name="label"]').fill('Estimating');
    await page.locator('.pp-form [type="submit"]').click();
    await page.getByRole('dialog', { name:'Estimating' }).waitFor();
    await page.locator('.pp-members .pp-list-state').waitFor();
    await shot(page, 'department-modal-empty');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Subcontractors: several types, link status, overview, link, payment terms; tabs without a backend are absent', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'subcontractors' });
    assert.equal(await page.locator('.pp-list-head h2').innerText(), 'Subcontractors');
    assert.equal(await page.locator('.pp-list-sub').innerText(), '4 subcontractors, 1 linked');
    assert.deepEqual(await page.locator('.pp-list-tools .pp-btn').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Types', 'New subcontractor']);
    const summit = page.locator('[data-row-key="c1"]');
    assert.equal(await summit.locator('.pp-pill.ok').innerText(), 'Linked');
    assert.match(await summit.locator('.pp-row-secondary').innerText(), /Dale Whitaker · dale@summitroofing\.example/);
    assert.ok(await summit.locator('.pp-row-chips .pp-chip.group:not([hidden])').count() >= 2, 'several types show');
    assert.equal(await page.locator('[data-row-key="c2"] .pp-pill.warn').innerText(), 'Link pending');
    assert.ok(await page.locator('[data-row-key="c2"]').evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().height <= 48));
    await shot(page, 'subcontractors-desktop');

    await page.locator('[data-list-action="0"]').click();
    const typesDialog = page.getByRole('dialog', { name:'Subcontractor types' });
    await typesDialog.waitFor();
    assert.equal(await typesDialog.locator('.pp-type').count(), 4);
    assert.equal(await typesDialog.locator('.pp-chip.role').count(), 0, 'company types give no roles');
    await shot(page, 'subcontractor-types');
    await typesDialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    await summit.locator('.pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'Summit Roofing' });
    await dialog.waitFor();
    assert.deepEqual(await dialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Overview', 'Link', 'Payment terms', 'Compensation', 'Fields']);
    assert.match(await dialog.locator('.pp-modal-summary').innerText(), /Summit Roofing[\s\S]*Linked[\s\S]*Roofing[\s\S]*Gutters[\s\S]*Debris hauling/);
    assert.doesNotMatch(await dialog.locator('.pp-modal-summary').innerText(), /Dale Whitaker/, 'the summary does not repeat the contact the Overview shows');
    assert.equal(await dialog.locator('[data-company-field="contact.name"]').inputValue(), 'Dale Whitaker');
    assert.equal(await dialog.locator('.pp-modal-panel:not([hidden])').evaluate((panel) => panel.scrollHeight <= panel.clientHeight + 1), true, 'the overview fits without scrolling');
    await shot(page, 'subcontractor-modal-overview');

    // Types come from a dropdown and several are allowed.
    await dialog.locator('[data-people-section-action="types"]').click();
    await page.getByRole('menuitemcheckbox', { name:'Electrical' }).click();
    await page.getByRole('menuitemcheckbox', { name:'Debris hauling' }).click();
    await page.keyboard.press('Escape');
    await dialog.locator('[data-company-field="contact.phone"]').fill('(555) 014-2299');
    await dialog.locator('.pp-tab', { hasText:'Link' }).click();
    assert.match(await dialog.locator('.pp-link-state').innerText(), /Linked/);
    assert.equal(await dialog.locator('[data-company-field="linked_organization_id"]').inputValue(), 'org_summit');
    await shot(page, 'subcontractor-modal-link');
    await dialog.locator('.pp-tab', { hasText:'Payment terms' }).click();
    assert.equal(await dialog.locator('[data-company-terms]').inputValue(), 'net_days');
    await dialog.locator('[data-company-field="terms.net_days"]').fill('30');
    await shot(page, 'subcontractor-modal-payment-terms');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    const writes = await page.evaluate(() => ({
      types:window.__people.calls.find((call) => call.action === 'assignees.profile.set').input,
      terms:window.__people.calls.find((call) => call.action === 'payroll.contractor.company.update'),
      update:window.__people.calls.find((call) => call.op === 'updateConnection').patch
    }));
    assert.deepEqual(writes.types, { assignee:{ type:'organization_connection', id:'c1' }, type_ids:['roofing_sub', 'gutters_sub', 'electrical_sub'] });
    assert.deepEqual(writes.terms.input.payment_terms, { basis:'net_days', net_days:30 });
    assert.equal(writes.terms.target.id, 'c1');
    assert.equal(writes.update.contacts[0].phone, '(555) 014-2299');
    assert.equal(writes.update.contacts[0].name, 'Dale Whitaker');
    assert.equal(writes.update.link_status, undefined, 'an untouched link is not rewritten');
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    // Linking: saving an organization id asks for the link.
    await page.locator('[data-row-key="c3"] .pp-row-name').click();
    const volt = page.getByRole('dialog', { name:'Volt Brothers' });
    await volt.locator('.pp-tab', { hasText:'Link' }).click();
    assert.match(await volt.locator('.pp-link-state').innerText(), /Not linked/);
    await volt.locator('[data-company-field="linked_organization_id"]').fill('org_volt');
    await volt.locator('[data-modal-save]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'updateConnection' && call.id === 'c3'));
    assert.deepEqual(await page.evaluate(() => { const patch = window.__people.calls.find((call) => call.op === 'updateConnection' && call.id === 'c3').patch; return [patch.linked_organization_id, patch.link_status]; }), ['org_volt', 'pending']);
    await volt.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    await page.locator('[data-row-key="c3"] .pp-pill.warn').waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Users parity: assignment tags, roles held in one department, and the admin level and seven flags without roles', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 });
    await page.locator('[data-row-key="u4"] .pp-row-name').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.locator('[data-people-section-action="tags"]').click();
    await page.getByRole('menuitemcheckbox', { name:'Bilingual' }).click();
    await page.keyboard.press('Escape');
    assert.match(await dialog.locator('[data-section="tags"]').innerText(), /Bilingual/);
    await dialog.locator('[data-people-section-action="scoped"]').click();
    await page.getByRole('menuitem', { name:'Give a role in one department' }).click();
    await page.locator('.pp-form [name="roleId"]').selectOption('production');
    await page.locator('.pp-form [name="departmentId"]').selectOption('department:service');
    await page.locator('.pp-form [type="submit"]').click();
    await dialog.locator('[data-section="scoped"]').getByText('Production · Service and warranty').waitFor();
    await shot(page, 'user-modal-tags-scoped-roles');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    const profile = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveUserProfile' && call.id === 'u4').pop().profile);
    assert.deepEqual(profile.assignment_tag_ids, ['bilingual']);
    assert.deepEqual(profile.scoped_access_assignments, [{ role_id:'production', scope:{ kind:'department', id:'service' } }]);
    assert.equal(profile.access_role_ids, undefined, 'roles are not rewritten when only tags change');
    assert.deepEqual(errors, []);

    // An organization without roles: the admin level is a dropdown, the seven flags are switches.
    const legacy = await openPage(browser, { width:1440, height:900 }, { flags:{ 'platform.expanded_access':false } });
    assert.equal(await legacy.page.locator('[data-row-key="u2"] .pp-chip.role').first().innerText(), 'Viewer');
    await legacy.page.locator('[data-row-key="u2"] .pp-row-name').click();
    const legacyDialog = legacy.page.getByRole('dialog');
    await legacyDialog.waitFor();
    assert.equal(await legacyDialog.locator('[data-legacy-level]').inputValue(), 'viewer');
    assert.equal(await legacyDialog.locator('.pp-perm-row').count(), 7);
    assert.equal(await legacyDialog.locator('[data-perm-key="view_reports"] [role="switch"]').getAttribute('aria-checked'), 'true');
    await legacyDialog.locator('[data-legacy-level]').selectOption('admin');
    assert.equal(await legacyDialog.locator('[data-perm-key="manage_billing"] [role="switch"]').getAttribute('aria-checked'), 'true');
    await legacyDialog.locator('[data-perm-key="manage_billing"] [role="switch"]').click();
    assert.equal(await legacyDialog.locator('[data-legacy-level]').inputValue(), 'custom');
    await shot(legacy.page, 'user-modal-legacy-flags');
    await legacyDialog.locator('[data-modal-save]').click();
    await legacy.page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'setPermissions'));
    const set = await legacy.page.evaluate(() => window.__people.calls.find((call) => call.op === 'setPermissions'));
    assert.equal(set.level, 'custom');
    assert.equal(set.items.manage_billing, false);
    assert.equal(set.items.manage_company_users, true);
    assert.equal(Object.keys(set.items).length, 7);
    assert.deepEqual(legacy.errors, []);
  } finally { await browser.close(); }
});

test('People at phone width: every page is one column and every modal is full screen', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:390, height:844 }, { view:'home' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(page, 'home-phone');
    for (const [view, key, name] of [['groups', 'g1', 'group'], ['departments', 'production', 'department'], ['subcontractors', 'c1', 'subcontractor']]) {
      await openView(page, view);
      assert.equal(await columnsOf(page, '.pp-list-body .pp-row'), 1, `${view} rows are one column`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${view} has no horizontal scrolling`);
      assert.equal(await page.locator('.pp-list-body .pp-row').evaluateAll((rows) => rows.every((row) => row.scrollWidth <= row.clientWidth + 1)), true, `${view} rows do not overflow`);
      await shot(page, `${view}-phone`);
      await page.locator(`.pp-list-body [data-row-key="${key}"] .pp-row-name`).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(260);
      const box = await page.locator('.pp-modal').boundingBox();
      assert.deepEqual([Math.round(box.width), Math.round(box.height)], [390, 844]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await shot(page, `${name}-modal-phone`);
      if (view === 'groups') { await page.locator('.pp-tab', { hasText:'Staffing' }).click(); await shot(page, 'group-modal-staffing-phone'); }
      await page.locator('[data-modal-close]').click();
      await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('People inside the real Settings shell (company.js): declared once, mounted by itself, sub-tabs hoisted, search entries', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport:{ width:1440, height:900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://people.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/libraries/')) return route.fulfill({ contentType:'application/javascript', body:await readFile(new URL(pathname.slice('/libraries/'.length), libraries)) });
      return route.fulfill({ contentType:'text/html', body:'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"><style>:root{--primary:#d93025;--primary-readable:#c5221f;--primary-rgb:217,48,37;--on-primary:#fff}html,body{height:100%;margin:0;background:#f0f2f5;font-family:Inter,system-ui,"Segoe UI",Arial,sans-serif}#tab_company_settings{height:100%;padding:18px 22px;box-sizing:border-box}</style></head><body><div id="tab_company_settings" class="active"></div></body></html>' });
    });
    await page.goto('http://people.test/');
    await page.evaluate(stubPlatform);
    await page.evaluate(stubDirectory);
    await page.evaluate(() => {
      // What the portal gives every app, reduced to what the Settings shell reads.
      const on = new Set(['platform.people_access', 'platform.expanded_access', 'platform.my_settings', 'apps.payroll']);
      window.PlatformAPI.appFlags = { has:(group, flag) => on.has(`${group}.${flag}`), value:() => undefined, current:() => ({}) };
      window.__people.route = { tab:'company_settings', sub:'people', settingsView:'', settingsEntity:'' };
      Object.assign(window.Portal, {
        util:{
          $:(selector, scope = document) => scope.querySelector(selector),
          escapeHtml:(value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[match])),
          injectCSS:(id, css) => { let style = document.getElementById(`css_${id}`); if (!style) { style = document.createElement('style'); style.id = `css_${id}`; document.head.appendChild(style); } style.textContent = css; },
          postAction:async () => ({ data:null }),
          hasPerm:() => true
        },
        apps:{ registerPortalApp:(definition) => { window.__settingsApp = definition; } },
        currentUser:{ permissions:{ manage_company_settings:true }, identity:{ preferences:{} } },
        appFlags:{ current:() => ({}), has:(group, flag) => on.has(`${group}.${flag}`) },
        navigation:{ read:() => ({ ...window.__people.route }), write:(route) => { Object.assign(window.__people.route, route); window.__people.routes.push(route); }, navigate:(route) => { window.__people.routes.push({ navigate:route }); } }
      });
    });
    // Load exactly what the app manifest loads for Settings, in its order, so the registration itself is exercised.
    const manifest = await readFile(new URL('apps/firstmate-apps-manifest.js', libraries), 'utf8');
    const block = manifest.slice(manifest.indexOf("id: 'portal.company_settings'"));
    const bundles = [...block.slice(block.indexOf('bundles: ['), block.indexOf('\n', block.indexOf('bundles: ['))).matchAll(/versionedBundle\('([^']+)'/g)].map((match) => new URL(match[1], 'http://people.test/libraries/apps/').pathname.replace('/libraries/', ''));
    assert.deepEqual(bundles.filter((file) => file.startsWith('apps/people/') && !PANELS.some((panel) => file.endsWith(`/${panel}.js`))), FILES.map((name) => `apps/people/${name}.js`), 'the manifest loads every People file, in dependency order');
    for (const panel of PANELS) assert.ok(bundles.indexOf(`apps/people/${panel}.js`) > bundles.indexOf('apps/people/people-data.js') && bundles.indexOf(`apps/people/${panel}.js`) < bundles.indexOf('apps/people/users-page.js'), `${panel} loads after the store and before the pages`);
    assert.ok(bundles.indexOf('custom-fields/firstmate-custom-fields.js') < bundles.indexOf('apps/people/fields-panel.js') && bundles.indexOf('payroll-api/payroll-api.js') < bundles.indexOf('apps/people/compensation-panel.js'));
    assert.ok(bundles.indexOf('apps/people/people-settings.js') < bundles.indexOf('apps/settings/company.js'));
    for (const file of ['platform-ui/platform-ui.js', 'settings-pages/firstmate-settings-pages.js', 'apps/settings/search.js', 'priority-fields/priority-fields.js', ...bundles]) await page.addScriptTag({ url:`http://people.test/libraries/${file}` });
    await page.evaluate(() => window.__settingsApp.mount(document.getElementById('tab_company_settings')));

    // One declaration gives the sidebar entry, the title and the pane; People fills the pane on its own.
    await page.locator('#csPanePeople.active .pp-card').first().waitFor();
    assert.equal(await page.locator('#csTabPeople').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[data-settings-title]').innerText(), 'People');
    assert.equal(await page.locator('#csPanePeople').getAttribute('data-settings-pane'), 'people');
    assert.deepEqual(await page.locator('.cs-subtabs-slot [data-settings-subtabs-proxy] button').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Overview', 'Users', 'Groups', 'Departments', 'Subcontractors']);
    assert.equal(await page.locator('#csPanePeople .fm-settings-subtabs').isVisible(), false, 'the shell hoists the sub-tabs out of the pane');
    assert.equal(await page.locator('#csTabUsers, #csTabCrews, #csPaneUsers, #csPaneCrews').count(), 0, 'the old Users and Crews and Subcontractors categories are gone');
    assert.equal(await page.evaluate(() => typeof window.FirstMeasureUsers + typeof window.FirstMateDepartments), 'undefinedundefined');
    await page.waitForFunction(() => !document.querySelector('.pp-card.loading'));
    await shot(page, 'real-shell-home');

    // Users inside the real card: two columns, header on one line, nothing autosaved, no stray shell styles.
    await page.locator('.cs-subtabs-slot [data-settings-subtabs-proxy] button').nth(1).click();
    await page.locator('#csPanePeople .pp-row').first().waitFor();
    assert.equal(await columnsOf(page, '#csPanePeople .pp-list-body .pp-row'), 2);
    assert.equal(await page.locator('#csPanePeople .pp-list-sub').innerText(), '42 users, 3 never signed in, 1 suspended');
    assert.equal(await page.locator('#csPanePeople [data-settings-autosave-trigger]').count(), 0, 'the shell autosave leaves People alone');
    const rowBox = await page.locator('#csPanePeople .pp-row').first().boundingBox();
    assert.ok(rowBox.height <= 48);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.ok(await page.evaluate(() => window.__people.route.sub === 'people' && window.__people.route.settingsView === 'users'));
    await shot(page, 'real-shell-users');
    await page.locator('#csPanePeople [data-row-key="u9"] .pp-row-name').click();
    await page.getByRole('dialog').waitFor();
    assert.ok(await page.evaluate(() => window.__people.route.settingsEntity === 'user:u9'));
    await shot(page, 'real-shell-user-modal');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    // Leaving and returning keeps one mounted instance; a shell re-render gets a fresh one.
    await page.locator('#csTabMySettings').click();
    assert.equal(await page.locator('#csPanePeople').isVisible(), false);
    await page.locator('#csTabPeople').click();
    await page.locator('#csPanePeople .pp-card').first().waitFor();
    await page.evaluate(() => { const panel = document.getElementById('tab_company_settings'); delete panel.dataset.companySettingsMounted; window.__settingsApp.mount(panel); });
    await page.locator('#csPanePeople.active .pp-card').first().waitFor();
    assert.equal(await page.locator('#csPanePeople .pp-people').count(), 1);

    // Settings search finds the People pages.
    const hits = await page.evaluate(() => window.FirstMateSettingsSearch.search('staffing requirements').map((item) => [item.section, item.view]));
    assert.deepEqual(hits[0], ['people', 'groups']);
    assert.ok(await page.evaluate(() => window.FirstMateSettingsSearch.search('subcontractors').some((item) => item.section === 'people' && item.view === 'subcontractors')));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Users: status filter chips, photo at invite, activity, and a role held in one organizational unit', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { setup:() => {
      // One archived (deleted) person, kept out of the counts.
      const list = window.PlatformAPI.users.list;
      window.PlatformAPI.users.list = async () => { const result = await list(); result.users.push({ id:'gone1', name:'Otto Former', email:'otto@northwind-exteriors.example', status:'deleted', deleted:true, access_role_ids:[] }); return result; };
      window.Portal.cfg = { serverEndpoint:'http://people.test/upload' };
    } });
    await page.route('http://people.test/upload', (route) => route.fulfill({ contentType:'application/json', body:JSON.stringify({ success:true, avatar_url:'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>' }) }));
    assert.deepEqual(await page.locator('[data-list-filter]').evaluateAll((chips) => chips.map((chip) => chip.textContent.trim())), ['All', 'Active38', 'Never signed in3', 'Suspended1', 'Archived1']);
    const filterBox = await page.locator('[data-list-filters]').boundingBox();
    const searchBox = await page.locator('.pp-search').boundingBox();
    assert.ok(Math.abs((filterBox.y + filterBox.height / 2) - (searchBox.y + searchBox.height / 2)) <= 2, 'chips sit on the header line');
    await page.locator('[data-list-filter="never"]').click();
    assert.equal(await page.locator('.pp-row').count(), 3);
    assert.match(await page.locator('.pp-list-sub').innerText(), /^3 of 42 users/);
    await page.locator('[data-list-filter="archived"]').click();
    assert.equal(await page.locator('.pp-row').count(), 1);
    assert.match(await page.locator('.pp-row').innerText(), /Otto Former[\s\S]*Archived/);
    assert.equal(await page.locator('.pp-row [data-row-action]').count(), 0, 'an archived person is shown for the record only');
    await shot(page, 'users-filter-archived');
    await page.locator('[data-list-filter="all"]').click();
    await shot(page, 'users-filter-chips');

    // Invite with a photo.
    await page.locator('[data-list-action="1"]').click();
    await page.locator('.pp-form [name="email"]').fill('pia@northwind-exteriors.example');
    await page.locator('.pp-form [name="photo"]').setInputFiles({ name:'pia.png', mimeType:'image/png', buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
    await page.locator('.pp-form [data-photo-preview] img').waitFor();
    await page.locator('.pp-form').getByRole('button', { name:'Sales', exact:true }).click();
    await shot(page, 'invite-user-photo');
    const upload = page.waitForRequest('http://people.test/upload');
    await page.locator('.pp-form [type="submit"]').click();
    assert.match((await upload).postData() || '', /org_users_upload_avatar_my[\s\S]*u43/);
    await page.locator('[data-row-key="u43"]').waitFor();

    // Activity, and a role held only in one unit.
    await page.locator('[data-row-key="u4"] .pp-row-name').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.pp-tab', { hasText:'Activity' }).click();
    await dialog.locator('.pp-activity li').first().waitFor();
    assert.equal(await dialog.locator('.pp-activity li').count(), 3);
    assert.match(await dialog.locator('.pp-activity').innerText(), /Uploaded 4 photos to 18 Maple Court/);
    assert.equal(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'activity').user), 'u4');
    await shot(page, 'user-modal-activity');
    await dialog.locator('[data-people-section-action="scoped"]').click();
    await page.getByRole('menuitem', { name:'Give a role in one department' }).click();
    await page.locator('.pp-form [name="roleId"]').selectOption('production');
    assert.ok(await page.locator('.pp-form [name="departmentId"] option', { hasText:'North region (Region)' }).count());
    await page.locator('.pp-form [name="departmentId"]').selectOption('division:north');
    await page.locator('.pp-form [type="submit"]').click();
    await dialog.locator('[data-section="scoped"]').getByText('Production · North region').waitFor();
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    assert.deepEqual(await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveUserProfile' && call.id === 'u4').pop().profile.scoped_access_assignments), [{ role_id:'production', scope:{ kind:'division', id:'north' } }]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Departments: units and categories lists, category and unit on a department, the channel switch and app visibility', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'departments' });
    assert.deepEqual(await page.locator('.pp-list-tools .pp-btn').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Units', 'Categories', 'New department']);
    await page.locator('[data-list-action="0"]').click();
    const units = page.getByRole('dialog', { name:'Organizational units' });
    await units.waitFor();
    assert.match(await units.locator('[data-type-id="north"]').innerText(), /North region[\s\S]*Region/);
    await units.locator('[data-list-new]').click();
    await page.locator('.pp-form [name="label"]').fill('Asheville office');
    await page.locator('.pp-form [name="kind"]').fill('Office');
    await page.locator('.pp-form [name="parent_id"]').selectOption('north');
    await page.locator('.pp-form [type="submit"]').click();
    await units.locator('.pp-type', { hasText:'Asheville office' }).waitFor();
    await shot(page, 'department-units');
    const unit = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveDepartments').pop().payload.divisions.find((entry) => entry.label === 'Asheville office'));
    assert.deepEqual([unit.kind, unit.parent_id, unit.status], ['Office', 'north', 'active']);
    await units.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    await page.locator('[data-list-action="1"]').click();
    const categories = page.getByRole('dialog', { name:'Categories' });
    await categories.locator('[data-list-new]').click();
    await page.locator('.pp-form [name="label"]').fill('Back office');
    await page.locator('.pp-form [type="submit"]').click();
    await categories.locator('.pp-type', { hasText:'Back office' }).waitFor();
    await shot(page, 'department-categories');
    await categories.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    await page.locator('.pp-list-body [data-row-key="office"] .pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'Office' });
    await dialog.waitFor();
    await dialog.locator('[data-people-identity]').click();
    await dialog.locator('select[data-identity="group_id"]').selectOption({ label:'Back office' });
    await dialog.locator('select[data-identity="division_id"]').selectOption('north');
    assert.equal(await dialog.locator('[data-dept-channel]').getAttribute('aria-checked'), 'true');
    await dialog.locator('[data-dept-channel]').click();
    await dialog.locator('.pp-tab', { hasText:'App visibility' }).click();
    assert.ok(await columnsOf(page, '.pp-app') >= 2);
    await dialog.locator('[data-apps-id="portal.payroll"] [data-apps-cell="desktop"]').click();
    assert.match(await dialog.locator('[data-apps-id="portal.payroll"]').getAttribute('class'), /overridden/);
    await shot(page, 'department-modal-app-visibility');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    const saved = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveDepartments').pop().payload.departments.find((entry) => entry.id === 'office'));
    assert.equal(saved.division_id, 'north');
    assert.equal(saved.default_channel, false);
    assert.deepEqual(saved.app_defaults, { 'portal.payroll':{ visibility:'hide', enforcement:'default' } });
    assert.ok(saved.group_id);
    assert.match(await dialog.locator('.pp-modal-summary').innerText(), /Back office[\s\S]*North region/);
    await shot(page, 'department-modal-category-unit');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Groups: the tag list, a role inside the group in the organization\'s own words, and inviting someone straight in', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'groups' });
    await page.locator('[data-list-action="1"]').click();
    const tags = page.getByRole('dialog', { name:'Tags' });
    await tags.waitFor();
    assert.equal(await tags.locator('.pp-type').count(), 3);
    assert.match(await tags.locator('[data-type-id="shingle"]').innerText(), /Shingle\s*1/);
    await tags.locator('[data-list-new]').click();
    await page.locator('.pp-form [name="name"]').fill('Tile');
    await page.locator('.pp-form [type="submit"]').click();
    await tags.locator('.pp-type', { hasText:'Tile' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'saveConfiguration').body.assignment_tags), [{ id:'tile', name:'Tile', status:'active' }]);
    await shot(page, 'group-tags');
    await tags.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    await page.locator('[data-row-key="g3"] .pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'South team' });
    await dialog.waitFor();
    await dialog.locator('.pp-members [data-row-key="u28"]').hover();
    await dialog.locator('.pp-members [data-row-key="u28"] [data-row-action="role"]').click();
    await page.locator('.pp-form [name="role"]').fill('Sawyer');
    await page.locator('.pp-form [type="submit"]').click();
    await dialog.locator('.pp-members [data-row-key="u28"] .pp-pill', { hasText:'Sawyer' }).waitFor();
    assert.equal(await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'updateResourceGroup' && call.id === 'g3').pop().patch.members.find((member) => member.user_id === 'u28').role), 'Sawyer');
    // Invite someone new straight into the group: they start with the roles its type gives.
    await dialog.locator('.pp-members [data-list-action="0"]').click();
    await page.locator('.pp-form [name="name"]').fill('Theo Marsh');
    await page.locator('.pp-form [name="email"]').fill('theo@northwind-exteriors.example');
    await page.locator('.pp-form [type="submit"]').click();
    await dialog.locator('.pp-members [data-row-key="u43"]').waitFor();
    const created = await page.evaluate(() => window.__people.calls.find((call) => call.op === 'create').data);
    assert.deepEqual(created.access_role_ids, ['crew_member']);
    assert.ok(await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'updateResourceGroup' && call.id === 'g3').pop().patch.members.some((member) => member.user_id === 'u43')));
    await shot(page, 'group-modal-member-role-invite');
    await page.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    await page.locator('[data-list-filter="empty"]').click();
    assert.deepEqual(await page.locator('.pp-row .pp-row-name').allInnerTexts(), ['Canvassers']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Overview: what needs attention opens the page filtered, Wording is one action, and no fixed copy says "crew"', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'home' });
    const rows = await page.locator('.pp-attention-row').evaluateAll((nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(rows, ['3 users never signed in', '9 users in no department', '1 group with no members', '3 subcontractors not linked']);
    await shot(page, 'home-attention');
    await page.locator('[data-home-wording]').click();
    const wording = page.locator('.pp-wording');
    await wording.waitFor();
    assert.equal(await wording.locator('[name="group_plural"]').count(), 0, 'groups are always called groups');
    await wording.locator('[name="company_singular"]').fill('Trade partner');
    await wording.locator('[name="company_plural"]').fill('Trade partners');
    await wording.locator('[name="department_plural"]').fill('Teams');
    await shot(page, 'home-wording');
    await wording.locator('[type="submit"]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'saveDepartments'));
    assert.deepEqual(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'saveConfiguration').body.terminology.organization_connection), { singular:'Trade partner', plural:'Trade partners' });
    assert.deepEqual(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'saveDepartments').payload.terminology.department), { singular:'Department', plural:'Teams' });
    await page.locator('[data-home-card="departments"] strong', { hasText:'Teams' }).waitFor();
    await page.locator('[data-home-attention="never"]').click();
    await page.locator('.pp-list-body[aria-busy="false"] .pp-row').first().waitFor();
    assert.equal(await page.locator('[data-list-filter="never"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.pp-row').count(), 3);
    assert.deepEqual(errors, []);

    // Fixed copy never names a group: every fallback string in People's own files is checked.
    for (const name of FILES) {
      const source = await readFile(new URL(`apps/people/${name}.js`, libraries), 'utf8');
      const copy = [...source.matchAll(/\bt\('[a-z0-9_]+', (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((match) => match[1] || match[2] || '');
      assert.deepEqual(copy.filter((text) => /crew/i.test(text)), [], `${name}.js`);
    }
  } finally { await browser.close(); }
});

// The real Settings shell with everything the manifest loads for it, including the Compensation and Fields panels
// (other modules' work) and the libraries they need. Payroll and custom fields answer from stubs.
async function openRealShell(browser, viewport, view = 'users'){
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://people.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/libraries/')) return route.fulfill({ contentType:'application/javascript', body:await readFile(new URL(pathname.slice('/libraries/'.length), libraries)) });
    return route.fulfill({ contentType:'text/html', body:'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"><style>:root{--primary:#d93025;--primary-readable:#c5221f;--primary-rgb:217,48,37;--on-primary:#fff}html,body{height:100%;margin:0;background:#f0f2f5;font-family:Inter,system-ui,"Segoe UI",Arial,sans-serif}#tab_company_settings{height:100%;padding:18px 22px;box-sizing:border-box}@media(max-width:820px){#tab_company_settings{padding:0}}</style></head><body><div id="tab_company_settings" class="active"></div></body></html>' });
  });
  await page.goto('http://people.test/');
  await page.evaluate(stubPlatform);
  await page.evaluate(stubDirectory);
  await page.evaluate((startView) => {
    const on = new Set(['platform.people_access', 'platform.expanded_access', 'platform.my_settings', 'apps.payroll']);
    window.PlatformAPI.appFlags = { has:(group, flag) => on.has(`${group}.${flag}`), value:() => undefined, current:() => ({}) };
    window.__people.route = { tab:'company_settings', sub:'people', settingsView:startView, settingsEntity:'' };
    Object.assign(window.Portal, {
      util:{
        $:(selector, scope = document) => scope.querySelector(selector),
        escapeHtml:(value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[match])),
        injectCSS:(id, css) => { let style = document.getElementById(`css_${id}`); if (!style) { style = document.createElement('style'); style.id = `css_${id}`; document.head.appendChild(style); } style.textContent = css; },
        postAction:async () => ({ data:null }),
        hasPerm:() => true
      },
      apps:{ registerPortalApp:(definition) => { window.__settingsApp = definition; } },
      currentUser:{ permissions:{ manage_company_settings:true }, identity:{ preferences:{} } },
      appFlags:{ current:() => ({}), has:(group, flag) => on.has(`${group}.${flag}`) },
      navigation:{ read:() => ({ ...window.__people.route }), write:(route) => { Object.assign(window.__people.route, route); window.__people.routes.push(route); }, navigate:(route) => { window.__people.routes.push({ navigate:route }); } }
    });
    // Custom fields: one field that comes from the Sales role, and definitions for any home.
    const read = window.PlatformAPI.publication.read;
    window.PlatformAPI.publication.read = async (orgId, source) => {
      if (source.provider === 'custom-fields-homes') return { status:'ready', value:{ home:{ kind:source.args?.kind, id:source.args?.id, name:'', exists:true }, entity:'user', revision:'rev-1', retired:[], fields:[{ entity:'user', home:{ kind:source.args?.kind, id:source.args?.id }, path:'truck_number', label:'Truck number', type:'text', required:false, order:0 }] } };
      if (String(source.provider).startsWith('custom-fields-')) return { status:'ready', value:{ entity:String(source.provider).replace('custom-fields-', ''), id:source.target?.id || '', recordRevision:2, homes:[{ kind:'role', id:'sales', name:'Sales', fields:['employee_number'] }], unassigned:[], fields:[{ path:'employee_number', label:'Employee number', type:'text', required:false, writable:true, schema:{ type:'string' }, homes:[{ kind:'role', id:'sales', name:'Sales' }] }], values:{ employee_number:'E-207' } } };
      return read(orgId, source);
    };
  }, view);
  const manifest = await readFile(new URL('apps/firstmate-apps-manifest.js', libraries), 'utf8');
  const block = manifest.slice(manifest.indexOf("id: 'portal.company_settings'"));
  const bundles = [...block.slice(block.indexOf('bundles: ['), block.indexOf('\n', block.indexOf('bundles: ['))).matchAll(/versionedBundle\('([^']+)'/g)].map((match) => new URL(match[1], 'http://people.test/libraries/apps/').pathname.replace('/libraries/', ''));
  for (const file of ['platform-ui/platform-ui.js', 'settings-pages/firstmate-settings-pages.js', 'apps/settings/search.js', 'priority-fields/priority-fields.js', ...bundles]) await page.addScriptTag({ url:`http://people.test/libraries/${file}` });
  await page.evaluate(() => {
    // Payroll answers from here; the panel talks to nothing else.
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const version = (definition) => [{ effective_from:'2026-01-01', definition }];
    const rules = [
      { id:'hourly', name:'Hourly', description:'Approved hours each week.', status:'active', versions:version({ parameters:{ rate_cents:{ label:'Hourly rate', type:'cents' } } }) },
      { id:'commission', name:'Commission', description:'A share of the contract.', status:'active', versions:version({ parameters:{ rate_bps:{ label:'Share', type:'basis_points', default:500 } } }) },
      { id:'bonus', name:'Flat bonus', description:'A fixed amount each month.', status:'active', versions:version({ parameters:{} }) }
    ];
    const everyone = { source:{ type:'organization', id:'org', name:'Everyone' }, entries:[{ id:'e1', kind:'add', rule_id:'hourly', params:{ rate_cents:2500 }, effective_from:'2026-01-01', entered_by:'owner' }], schedules:[{ id:'c1', earning_kind:'*', schedule_id:'weekly', effective_from:'2026-01-01' }] };
    const setups = {}, defaults = {};
    const key = (ref) => `${ref.type}:${ref.id}`;
    const setup = (payee) => (setups[key(payee)] ||= { payee, entries:[], revision:1, layers:[everyone, { source:null, entries:[] }], distribution_today:payee.type === 'resource_group' ? { mode:'as_one' } : null });
    const fallback = (subject) => (defaults[key(subject)] ||= { subject, subject_name:'', revision:1, entries:[], covers_count:0, covers:[] });
    const stored = (row, payload) => { Object.assign(row, { entries:copy(payload.entries || []), schedules:copy(payload.schedules || []), distribution:copy(payload.distribution || []), revision:row.revision + 1 }); return copy(row); };
    window.__pay = [];
    window.PayrollAPI = {
      ...(window.PayrollAPI || {}),
      schedules:{ list:async () => ({ schedules:[{ id:'weekly', name:'Weekly', status:'active' }, { id:'monthly', name:'Monthly', status:'active' }] }) },
      pay:{
        rules:async () => copy(rules), plans:async () => [], splitRules:async () => [{ id:'present', name:'Present on the job', description:'', status:'active', versions:version({ parameters:{} }) }],
        unresolved:async () => [{ payee:{ type:'organization_user', id:'u3' }, rule_id:'hourly', reason:'Set an hourly rate.' }, { payee:{ type:'organization_user', id:'u5' }, rule_id:'hourly', reason:'Set an hourly rate.' }],
        setup:async (orgId, payee) => copy(setup(payee)), default:async (orgId, subject) => copy(fallback(subject)),
        previewSetup:async (orgId, payload) => { window.__pay.push({ op:'setup.preview', payee:payload.payee }); return { differences:[], unresolved:[], total_change_cents:0 }; },
        saveSetup:async (orgId, payload) => { window.__pay.push({ op:'setup.save', payee:payload.payee, entries:payload.entries }); return stored(setup(payload.payee), payload); },
        previewDefault:async (orgId, payload) => { window.__pay.push({ op:'default.preview', subject:payload.subject }); return { payee_count:0, changed_payee_count:0, difference_count:0, change_cents:0, payees:[] }; },
        saveDefault:async (orgId, payload) => { window.__pay.push({ op:'default.save', subject:payload.subject }); return stored(fallback(payload.subject), payload); }
      }
    };
    window.__settingsApp.mount(document.getElementById('tab_company_settings'));
  });
  await page.locator('#csPanePeople.active .pp').first().waitFor();
  return { page, errors };
}

test('Compensation and Fields panels inside the real entity modal: every kind, a preview before pay is saved, phone width', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openRealShell(browser, { width:1440, height:900 });
    await page.locator('#csPanePeople [data-row-key="u3"] .pp-row-name').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();

    // Compensation: the panel, not the placeholder.
    await dialog.locator('.pp-tab', { hasText:'Compensation' }).click();
    await dialog.locator('[data-comp-rule="hourly"]').waitFor();
    assert.equal(await dialog.locator('[data-people-slot-empty]').count(), 0);
    assert.equal(await dialog.locator('[data-comp-distribution]').count(), 0, 'a person has no members to divide pay among');
    await shot(page, 'user-modal-compensation');
    // The modal's Save: the panel declines once to show what would change. That is a message, not an error.
    await dialog.locator('[data-comp-add-rule]').selectOption('bonus');
    assert.equal(await dialog.locator('[data-modal-save]').isEnabled(), true);
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'notice');
    assert.match(await dialog.locator('.pp-modal-status').innerText(), /Check what this changes, then save again/);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await dialog.locator('[data-modal-save]').isEnabled(), true);
    assert.notEqual(await dialog.locator('.pp-modal-status').evaluate((status) => getComputedStyle(status).color), 'rgb(180, 35, 24)', 'no error styling');
    await dialog.locator('[data-comp-preview]').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__pay.map((call) => call.op)), ['setup.preview']);
    await shot(page, 'user-modal-compensation-preview');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    assert.deepEqual(await page.evaluate(() => window.__pay.map((call) => call.op)), ['setup.preview', 'setup.save']);
    assert.deepEqual(await page.evaluate(() => window.__pay[1].payee), { type:'organization_user', id:'u3' });

    // Fields: values grouped by the role each field comes from.
    await dialog.locator('.pp-tab', { hasText:'Fields' }).click();
    await dialog.locator('[data-fm-cf-input="employee_number"]').waitFor();
    assert.equal(await dialog.locator('[data-fm-cf-input="employee_number"]').inputValue(), 'E-207');
    await shot(page, 'user-modal-fields');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    // A role is a home: its pay default and its field definitions.
    await page.locator('#csPanePeople [data-list-action="0"]').click();
    await page.getByRole('menuitem', { name:/^Sales/ }).click();
    const role = page.getByRole('dialog', { name:'Sales' });
    await role.locator('.pp-tab', { hasText:'Compensation' }).click();
    await role.locator('[data-comp-add-rule]').waitFor();
    await shot(page, 'role-modal-compensation');
    await role.locator('.pp-tab', { hasText:'Fields' }).click();
    await role.getByText('Truck number').first().waitFor();
    await shot(page, 'role-modal-fields');
    await role.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    // A group: pay can be divided among its members, and the panel is given their names.
    await page.locator('.cs-subtabs-slot [data-settings-subtabs-proxy] button').nth(2).click();
    await page.locator('#csPanePeople [data-row-key="g1"] .pp-row-name').click();
    const group = page.getByRole('dialog', { name:'North team' });
    await group.locator('.pp-tab', { hasText:'Compensation' }).click();
    await group.locator('[data-comp-distribution]').waitFor();
    await shot(page, 'group-modal-compensation');
    await group.locator('.pp-tab', { hasText:'Fields' }).click();
    await group.locator('[data-fm-cf-input="employee_number"]').waitFor();
    await group.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    // A group type, opened like a role.
    await page.locator('#csPanePeople [data-list-action="0"]').click();
    await page.getByRole('dialog', { name:'Group types' }).locator('[data-type-id="crew"] .pp-type-open').click();
    const type = page.getByRole('dialog', { name:'Install crew' });
    await type.locator('.pp-tab', { hasText:'Compensation' }).click();
    await type.locator('[data-comp-add-rule]').waitFor();
    await shot(page, 'group-type-modal-compensation');
    await type.locator('.pp-tab', { hasText:'Fields' }).click();
    await type.getByText('Truck number').first().waitFor();
    await shot(page, 'group-type-modal-fields');
    await type.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    // An outside company and a company type; the Permissions tab stays hidden while its read does not exist.
    await page.locator('.cs-subtabs-slot [data-settings-subtabs-proxy] button').nth(4).click();
    await page.locator('#csPanePeople [data-row-key="c1"] .pp-row-name').click();
    const company = page.getByRole('dialog', { name:'Summit Roofing' });
    await company.waitFor();
    assert.equal(await company.locator('.pp-tab', { hasText:'Permissions' }).count(), 0);
    assert.ok(await page.evaluate(() => window.__people.calls.some((call) => call.op === 'read' && call.source === 'assignee-directory.permission-defaults')), 'the read is asked for');
    await company.locator('.pp-tab', { hasText:'Compensation' }).click();
    await company.locator('[data-comp-rule="hourly"]').waitFor();
    await shot(page, 'subcontractor-modal-compensation');
    await company.locator('.pp-tab', { hasText:'Fields' }).click();
    await company.locator('[data-fm-cf-input="employee_number"]').waitFor();
    await shot(page, 'subcontractor-modal-fields');
    await company.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    // The overview knows about pay that could not be worked out, because payroll reports it.
    await page.locator('.cs-subtabs-slot [data-settings-subtabs-proxy] button').nth(0).click();
    await page.locator('[data-home-attention="pay"]').waitFor();
    assert.match(await page.locator('[data-home-attention="pay"]').innerText(), /2\s*earnings that could not be worked out/);
    await shot(page, 'real-shell-home-attention');
    assert.deepEqual(errors, []);

    // Phone width.
    const phone = await openRealShell(browser, { width:390, height:844 });
    await phone.page.locator('#csPanePeople [data-row-key="u3"] .pp-row-name').click();
    const sheet = phone.page.getByRole('dialog');
    await sheet.waitFor();
    await sheet.locator('.pp-tab', { hasText:'Compensation' }).click();
    await sheet.locator('[data-comp-rule="hourly"]').waitFor();
    // (The shell's own narrow layout is wider than this bare test page by its usual portal gutter; People is measured on its own.)
    assert.deepEqual(await phone.page.locator('.pp-modal').evaluate((modal) => { const box = modal.getBoundingClientRect(); return [Math.round(box.left), Math.round(box.width)]; }), [0, 390]);
    assert.equal(await sheet.locator('.pp-modal-panel:not([hidden])').evaluate((panel) => panel.scrollWidth <= panel.clientWidth + 1), true, 'the compensation panel fits the phone width');
    await shot(phone.page, 'user-modal-compensation-phone');
    await sheet.locator('.pp-tab', { hasText:'Fields' }).click();
    await sheet.locator('[data-fm-cf-input="employee_number"]').waitFor();
    assert.equal(await sheet.locator('.pp-modal-panel:not([hidden])').evaluate((panel) => panel.scrollWidth <= panel.clientWidth + 1), true, 'the fields panel fits the phone width');
    await shot(phone.page, 'user-modal-fields-phone');
    assert.deepEqual(phone.errors, []);
  } finally { await browser.close(); }
});

test('Subcontractors: the Permissions tab appears when the directory publishes a company\'s permission set', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'subcontractors', setup:() => {
      const read = window.PlatformAPI.publication.read;
      window.PlatformAPI.publication.read = async (orgId, source) => source.export === 'permission-defaults'
        ? { status:'ready', value:{ assignee:{ type:'organization_connection', id:String(source.target.id).split(':')[1] }, permission_defaults:{ access_role_ids:['crew_member'], permission_overrides:{ 'crew.payments.take':false } }, revision:3 } }
        : read(orgId, source);
      const invoke = window.PlatformAPI.publication.invoke;
      window.PlatformAPI.publication.invoke = async (orgId, action, target, input, options) => {
        if (action !== 'assignees.permission-defaults.set') return invoke(orgId, action, target, input, options);
        window.__people.calls.push({ op:'invoke', action, target, input, idempotencyKey:options?.idempotencyKey || '' });
        return { value:{ assignee:input.assignee, applies_to:'external_people', access_role_ids:input.access_role_ids, permission_overrides:input.permission_overrides, revision:4 } };
      };
    } });
    await page.locator('[data-row-key="c1"] .pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'Summit Roofing' });
    await dialog.locator('.pp-tab', { hasText:'Permissions' }).click();
    assert.match(await dialog.locator('[data-company-roles]').innerText(), /Installer/);
    await dialog.locator('[data-perm-group="crew"]').click();
    assert.match(await dialog.locator('[data-perm-key="crew.payments.take"]').getAttribute('class'), /overridden/);
    assert.match(await dialog.locator('[data-perm-key="crew.schedule.view"]').getAttribute('class'), /allowed/);
    assert.match(await dialog.locator('.pp-company-perm .pp-info').getAttribute('aria-label'), /does not change anyone's access yet/);
    await dialog.locator('[data-perm-key="crew.time_clock.use"] [data-choice="deny"]').click();
    await shot(page, 'subcontractor-modal-permissions');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.action === 'assignees.permission-defaults.set'));
    assert.deepEqual(await page.evaluate(() => window.__people.calls.find((call) => call.action === 'assignees.permission-defaults.set').input), { assignee:{ type:'organization_connection', id:'c1' }, access_role_ids:['crew_member'], permission_overrides:{ 'crew.payments.take':false, 'crew.time_clock.use':false } });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
