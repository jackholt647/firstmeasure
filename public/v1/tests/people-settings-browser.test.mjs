// People settings: the category shell, the shared pieces and the Users page, in a real browser with stubbed APIs.
// PEOPLE_SCREENSHOTS=1 writes screenshots to <repo>/output/people-ui/.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';

const libraries = new URL('../../libraries/', import.meta.url);
// The real permission catalog the access catalog publishes, with Equipment marked as switched off for this company.
const PERMISSION_CATALOG = (() => {
  const script = "for (const m of ['./platform/capability_defs.ts', './chat/capabilities.ts', './comms/capabilities.ts', './assistant/capabilities.ts']) await import(m); const { permissionCatalog } = await import('./platform/capabilities.ts'); process.stdout.write(JSON.stringify(permissionCatalog()));";
  const catalog = JSON.parse(execFileSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '--import', 'tsx', '--input-type=module', '-e', script], { cwd:path.resolve(import.meta.dirname, '..'), encoding:'utf8' }));
  catalog.categories.forEach((category) => category.subcategories.forEach((sub) => sub.permissions.forEach((entry) => { entry.available = !entry.key.startsWith('equipment.'); })));
  return catalog;
})();
const shots = process.env.PEOPLE_SCREENSHOTS ? path.resolve(import.meta.dirname, '..', '..', '..', 'output', 'people-ui') : '';
// The two slot panels are other modules' work; most cases run without them so the slot contract itself is what is tested.
// The Settings bundle can name a file another module has not written yet; the portal would skip it the same way. People's own files must all be there.
const present = (file) => file.startsWith('apps/people/') || existsSync(new URL(file, new URL('../../libraries/', import.meta.url)));
const PANELS = ['fields-panel', 'compensation-panel', 'pay-sheets-model', 'pay-sheets-editor', 'pay-sheets-list'];
const FILES = ['people-kit', 'list-page', 'entity-modal', 'hover-card', 'permissions-panel', 'app-grid', 'slots', 'people-data', 'people-directory', 'page-kit', 'people-lists', 'branches', 'onboarding', 'users-page', 'groups-page', 'departments-page', 'companies-page', 'people-home', 'people-settings'];
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
    { id:'admin', name:'Administrator', description:'Runs the company account', is_system:true, permissions:{ '*':true }, app_defaults:{}, revision:3 },
    { id:'office', name:'Office manager', description:'Scheduling, billing and people', permissions:{ manage_company_users:true, manage_schedule:true, view_projects:true, manage_projects:true, view_reports:true }, app_defaults:{}, revision:2 },
    { id:'sales', name:'Sales', description:'Sells and follows up', permissions:{ view_projects:true, 'sales.dashboard.view':true, 'sales.schedule.view':true, 'sales.followups.manage':true, 'sales.earnings.view':true }, app_defaults:{ 'portal.payroll':{ visible:{ desktop:false } } }, revision:5 },
    { id:'production', name:'Production', description:'Plans and runs installs', permissions:{ view_projects:true, manage_projects:true, manage_schedule:true, view_schedule:true }, app_defaults:{}, revision:1 },
    { id:'crew_foreman', name:'Foreman', description:'Leads a group in the field', is_system:true, permissions:{ 'crew.dashboard.view':true, 'crew.projects.view':true, 'crew.schedule.view':true, 'crew.receipts.upload':true, 'crew.checklists.view':true, 'crew.checklists.complete':true, 'crew.materials.view':true, 'crew.payments.take':true }, app_defaults:{}, revision:1 },
    { id:'crew_member', name:'Installer', description:'Works in the field', is_system:true, permissions:{ 'crew.dashboard.view':true, 'crew.projects.view':true, 'crew.schedule.view':true, 'crew.receipts.upload':true, 'crew.checklists.view':true }, app_defaults:{}, revision:1 },
    { id:'phones', name:'Phones', description:'Answers and places calls', permissions:{ view_projects:true, use_phone:true }, app_defaults:{}, revision:1 }
  ];
  // The App experience catalog: each app with its devices, default and options (docs/architecture/app-experience.md).
  const tab = (id, title, icon, kind, surface = 'portal_tab', extra = {}) => ({ id, title, icon, description:`${title} app`, surface, devices:['desktop', 'mobile'], default_visible:kind !== 'field', options:[], parameter_permissions:{}, order:0, ...extra });
  const apps = [
    tab('portal.viewer', 'My Projects', 'fa-briefcase', 'management'), tab('portal.contacts', 'My Contacts', 'fa-address-book', 'management'), tab('portal.photos_feed', 'Feed', 'fa-images', 'management'),
    tab('portal.proposals', 'Proposals', 'fa-file-signature', 'management'), tab('portal.scheduling', 'Scheduling', 'fa-calendar-days', 'management', 'portal_tab', { required_permissions:['view_schedule'] }), tab('portal.invoices', 'Invoices', 'fa-file-invoice-dollar', 'management'),
    tab('portal.financials', 'Financials', 'fa-chart-line', 'management', 'portal_tab', { devices:['desktop'] }), tab('portal.payroll', 'Payroll', 'fa-money-check-dollar', 'management', 'portal_tab', { devices:['desktop'], default_visible:false }), tab('portal.calls', 'Calls', 'fa-phone', 'management', 'portal_tab', { required_permissions:['use_phone'] }),
    tab('portal.canvassing', 'Canvassing', 'fa-map-location-dot', 'management'), tab('portal.company_settings', 'Settings', 'fa-gear', 'management'),
    tab('project.map', 'Project Overview', 'fa-map', 'management', 'project_modal'), tab('project.photos', 'Project Photos', 'fa-camera', 'management', 'project_modal'), tab('project.proposal', 'Project Proposals', 'fa-file-signature', 'management', 'project_modal'),
    tab('project.docs', 'Project Docs', 'fa-folder-open', 'management', 'project_modal'), tab('project.materials', 'Scope', 'fa-clipboard-list', 'management', 'project_modal'), tab('project.money', 'Money', 'fa-wallet', 'management', 'project_modal'),
    tab('project.schedule', 'Project Schedule', 'fa-calendar-days', 'management', 'project_modal'), tab('project.measurements', 'Reports', 'fa-ruler-combined', 'management', 'project_modal'), tab('project.checklists', 'Checklists', 'fa-list-check', 'management', 'project_modal'),
    tab('portal.crew_overview', 'Today', 'fa-sun', 'field', 'portal_tab', { options:[{ key:'time_clock', label:'Time clock', description:'Clock in and out from Today.', default:false, param:'time_clock_enabled' }] }), tab('portal.crew_schedule', 'Schedule', 'fa-calendar-week', 'field'), tab('portal.crew_payouts', 'Earnings', 'fa-sack-dollar', 'field'), tab('portal.crew_receipts', 'Receipts', 'fa-receipt', 'field', 'portal_tab', { devices:['mobile'] }),
    tab('project.crew_overview', 'Visit', 'fa-location-dot', 'field', 'project_modal'), tab('project.crew_materials', 'Materials', 'fa-boxes-stacked', 'field', 'project_modal'), tab('project.crew_payments', 'Payments', 'fa-credit-card', 'field', 'project_modal')
  ];
  const departments = [
    { id:'sales', branch_id:'default', label:'Sales', color:'#2563eb', status:'active', subject_keys:[], role_ids:['sales'], group_kind_ids:[] },
    { id:'production', branch_id:'default', label:'Production', color:'#16a34a', status:'active', subject_keys:[], role_ids:['production', 'crew_foreman', 'crew_member'], group_kind_ids:[] },
    { id:'office', branch_id:'default', label:'Office', color:'#9333ea', status:'active', subject_keys:[], role_ids:['office'], group_kind_ids:[] },
    { id:'service', branch_id:'default', label:'Service and warranty', color:'#ea580c', status:'active', subject_keys:[], role_ids:[], group_kind_ids:[] },
    { id:'warehouse', branch_id:'default', label:'Warehouse', color:'#0891b2', status:'active', subject_keys:[], role_ids:[], group_kind_ids:[] }
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
  Object.assign(users.find((user) => user.id === 'u7'), { worker_classification:'independent_contractor', payment_terms:{ basis:'net_days', net_days:30 } });
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
    return { id:user.id, department_ids:[...new Set(sources.map((source) => source.department_id))], sources };
  });
  window.__departmentExtras = {};
  /* One branch, unnamed, by default; multiBranch() gives the organization several. */
  const branchState = { branches:[{ id:'default', name:'', status:'active', is_default:true, region_id:'' }], regions:[], my:['default'], myRegions:null, revision:7, access:{} };
  const departmentState = () => copy({ revision:4, legacy_token:'', departments, regions:branchState.regions, branches:branchState.branches.map(({ id, name, status, is_default }) => ({ id, name, status, is_default })), branch_scope:{ multiple:branchState.branches.filter((entry) => entry.status === 'active').length > 1, my_branch_id:branchState.my[0], visible_branch_ids:branchState.branches.map((entry) => entry.id), manageable_branch_ids:branchState.branches.map((entry) => entry.id) }, terminology:window.__departmentExtras.terminology || { department:{ singular:'Department', plural:'Departments' } }, effective_memberships:memberships(), can_manage:true, can_assign:{ user:true, role:true, group:true } });
  const normalize = (doc) => { const data = doc?.data && typeof doc.data === 'object' ? { id:doc.id, ...doc.data } : { ...(doc || {}) }; return { ...data, disabled:data.disabled === true || data.status === 'disabled' }; };
  window.__people = { calls, users, roles, departments, branchState, toasts:[], presence:null, routes:[], route:{ sub:'people', settingsView:'', settingsEntity:'' }, flags:{} };
  window.__APP = { userOrgId:'org', userId:'u1', userEmail:users[0].email, userName:users[0].name };
  window.Portal = {
    util:{ hasPerm:() => true },
    ui:{ showToast:(title, message, ok) => { window.__people.toasts.push({ title, message, ok }); window.PlatformUI?.showToast?.(title, message, ok); } },
    terminology:{ words:{}, get(key, fallback){ const branch = String(key).startsWith('branches.') ? this.words[String(key).slice(9)] : ''; return branch || ({ 'workforce.resource_group_plural':'Crews and teams', 'workforce.resource_group_singular':'Crew or team' }[key] || fallback); } },
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
      remove:async (orgId, id, options = {}) => { const user = users.find((entry) => entry.id === id); Object.assign(user, { deleted:true, status:'disabled', status_before_archive:user.status, deleted_at:'2026-10-19T12:00:00Z', ...(options.reason ? { archived_reason:options.reason } : {}) }); calls.push({ op:'remove', id, reason:options.reason || '' }); return { ok:true, archived:true }; },
      setPermissions:async (orgId, id, level, items) => { const user = users.find((entry) => entry.id === id); user.role = level; user.org_permissions = { level, items }; calls.push({ op:'setPermissions', id, level, items }); return { document:{ id, data:copy(user) } }; }
    },
    workforce:{
      users:async () => ({ users:copy(users) }),
      accessCatalog:async () => copy({ device_types:{ classify:['mobile', 'desktop'], types:[{ id:'desktop', label:'Desktop', icon:'fa-desktop', match:{} }, { id:'mobile', label:'Phone', icon:'fa-mobile-screen', match:{ max_width:820 } }] }, permission_keys:['crew.dashboard.view', 'crew.projects.view', 'crew.projects.view_all_production', 'crew.schedule.view', 'crew.receipts.upload', 'crew.reimbursements.request', 'crew.materials.view', 'crew.materials.append', 'crew.payouts.view', 'crew.checklists.view', 'crew.checklists.complete', 'crew.payments.view', 'crew.payments.take', 'sales.dashboard.view', 'sales.schedule.view', 'sales.followups.manage', 'sales.earnings.view', 'sales.documents.view_status', 'sales.money.view_status', 'sales.stats.view_own', 'sales.stats.view_team', 'manage_billing', 'manage_company_settings', 'manage_company_user_permissions', 'order_reports', 'manage_report_settings', 'manage_payroll'], permission_catalog:window.__permissionCatalog, apps, roles }),
      departments:async () => departmentState(),
      saveDepartments:async (orgId, payload) => {
        calls.push({ op:'saveDepartments', payload:copy(payload) });
        const allowed = ['id', 'label', 'color', 'icon', 'branch_id', 'status', 'default_channel', 'app_defaults', 'subject_keys', 'role_ids', 'group_kind_ids'];
        const extra = [...Object.keys(payload).filter((key) => !['departments', 'terminology', 'revision', 'legacy_token'].includes(key)), ...payload.departments.flatMap((entry) => Object.keys(entry).filter((key) => !allowed.includes(key)))];
        if (extra.length) { const error = new Error(`Unrecognized key(s): ${extra.join(', ')}`); error.status = 400; throw error; }
        departments.splice(0, departments.length, ...copy(payload.departments).map((entry) => ({ branch_id:departments.find((old) => old.id === entry.id)?.branch_id || branchState.my[0], ...entry })));
        if (payload.terminology) window.__departmentExtras.terminology = copy(payload.terminology);
        return departmentState();
      },
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
    ...users.map((user) => ({ id:`organization_user:${user.id}`, kind:'organization_user', assignee_id:user.id, name:user.name, status:'active', type_ids:user.access_role_ids, type_names:[], role_ids:user.access_role_ids, tag_ids:user.assignment_tag_ids || [], department_ids:[], branch_ids:user.branch_ids || ['default'], traits:{ has_members:false, has_login:true, external_link:false, splits_pay:false }, link_status:'', fields:{ has_cdl:['u6', 'u27'].includes(user.id) }, fields_error:'', member_ids:[], member_count:0, members:[], group_ids:[] })),
    ...groups.filter((group) => group.status === 'active').map((group) => ({ id:`resource_group:${group.id}`, kind:'resource_group', assignee_id:group.id, name:group.name, status:'active', type_ids:[group.kind_id], type_names:typeNames([group.kind_id]), role_ids:[], tag_ids:group.assignment_tag_ids, department_ids:[], branch_ids:group.branch_ids || ['default'], traits:{ has_members:true, has_login:false, external_link:false, splits_pay:true }, link_status:'', fields:{}, fields_error:'', member_ids:group.members.map((entry) => `organization_user:${entry.user_id}`), member_count:group.members.length, members:[], group_ids:[] })),
    ...connections.filter((company) => company.status === 'active').map((company) => ({ id:`organization_connection:${company.id}`, kind:'organization_connection', assignee_id:company.id, name:company.name, status:'active', type_ids:companyTypes[company.id] || [], type_names:typeNames(companyTypes[company.id] || []), role_ids:[], tag_ids:[], department_ids:[], branch_ids:company.branch_ids || [], traits:{ has_members:false, has_login:company.link_status === 'linked', external_link:true, splits_pay:false }, link_status:company.link_status, fields:{}, fields_error:'', member_ids:[], member_count:0, members:[], group_ids:[] }))
  ];
  Object.assign(window.__people, { groups, connections, types, companyTypes, staffing });
  const api = window.PlatformAPI;
  // Documents an outside company uploads; collaboration invitations; the organization's words (variable mappings).
  const media = [];
  api.media = { upload:async (orgId, file, options = {}) => { const item = { id:`media_${media.length + 1}`, file_name:file.name, owner:{ type:options.ownerType, id:options.ownerId } }; media.push(item); calls.push({ op:'mediaUpload', owner:item.owner, name:file.name }); return { ok:true, media:item }; } };
  const invitations = [];
  api.request = async (url, options = {}) => {
    const path = new URL(url).pathname.replace(/^\/v1\/collaboration\/organizations\/[^/]+/, '');
    calls.push({ op:'collaboration', path, method:options.method || 'GET', body:copy(options.body || null) });
    if (path === '/partner-invitations') { const invitation = { id:`invitation_${invitations.length + 1}`, revision:1, status:'pending', email:options.body.email, label:options.body.name, workforce_connection_id:options.body.workforce_connection_id }; invitations.push(invitation); const company = connections.find((entry) => entry.id === options.body.workforce_connection_id); if (company) { company.link_status = 'pending'; company.metadata = { ...(company.metadata || {}), collaboration_invitation_id:invitation.id, collaboration_invitation_status:'pending', collaboration_invitation_email:invitation.email }; company.revision += 1; } return { ok:true, invitation:copy(invitation), url:'/portal/#collaboration_invite=x' }; }
    const match = path.match(/^\/invitations\/([^/]+)\/(send|link|revoke)$/);
    const invitation = match && invitations.find((entry) => entry.id === match[1]);
    if (match && match[2] === 'send') return { ok:true, invitation:copy(invitation), delivery:{ status:'captured' } };
    if (match && match[2] === 'link') return { ok:true, invitation:copy(invitation), url:'/portal/#collaboration_invite=x' };
    if (match && match[2] === 'revoke') { invitation.status = 'revoked'; invitation.revision += 1; const company = connections.find((entry) => entry.id === invitation.workforce_connection_id); if (company) { company.link_status = 'unlinked'; company.metadata = { ...company.metadata, collaboration_invitation_status:'revoked' }; company.revision += 1; } return { ok:true, invitation:copy(invitation) }; }
    throw new Error(`Unknown request ${path}`);
  };
  const variableMappings = { labels:{} };
  api.branches = { modules:{ get:async (orgId, branchId, moduleId) => ({ ok:true, module:{ data:copy(moduleId === 'variable_mappings' && branchId === 'default' ? variableMappings : {}) } }), patch:async (orgId, branchId, moduleId, data) => { calls.push({ op:'modulePatch', branchId, moduleId, data:copy(data) }); if (moduleId === 'variable_mappings' && branchId === 'default') Object.assign(variableMappings, copy(data)); const words = (variableMappings.labels || {}).branches || {}; window.Portal.terminology.words = words; return { ok:true }; } } };
  Object.assign(window.__people, { media, invitations, variableMappings });
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
  api.workforce.resourceGroups = async (orgId, branchId, options = {}) => { calls.push({ op:'resourceGroups', branchId, branchIds:options.branchIds || '' }); return { resource_groups:copy(groups.filter((group) => group.status === 'active')) }; };
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
    list:async (orgId, options = {}) => { calls.push({ op:'connections', options:copy(options) }); return { organization_connections:copy(connections.filter((company) => company.status === 'active')) }; },
    create:async (orgId, body) => { const company = { id:`c${connections.length + 1}`, status:'active', revision:1, contacts:[], address:{}, metadata:{}, payment_terms:{}, link_status:'unlinked', ...body }; connections.push(company); calls.push({ op:'createConnection', body:copy(body) }); return { organization_connection:copy(company) }; },
    update:async (orgId, id, patch) => { const company = connections.find((entry) => entry.id === id); const { expected_revision, ...rest } = patch; Object.assign(company, rest, { revision:company.revision + 1 }); calls.push({ op:'updateConnection', id, patch:copy(patch) }); return { organization_connection:copy(company) }; },
    archive:async (orgId, id) => { connections.find((entry) => entry.id === id).status = 'archived'; calls.push({ op:'archiveConnection', id }); return { ok:true }; }
  };
  const branchState = window.__people.branchState;
  const structure = () => {
    const active = branchState.branches.filter((entry) => entry.status === 'active');
    const feature = window.__people.flags['platform.multiple_branches'] !== false;
    const regionOf = (id) => branchState.regions.find((region) => region.status !== 'archived' && region.branch_ids.includes(id))?.id || '';
    const myRegions = branchState.myRegions || [...new Set(branchState.my.map(regionOf).filter(Boolean))];
    const count = (id) => users.filter((user) => (user.branch_ids || ['default']).includes(id)).length;
    return copy({
      feature_enabled:feature, multiple:feature && active.length > 1, default_branch_id:'default', my_branch_id:branchState.my[0], my_branch_ids:branchState.my, my_region_ids:myRegions,
      branches:branchState.branches.map((entry) => ({ ...entry, region_id:regionOf(entry.id), is_mine:branchState.my.includes(entry.id), counts:{ users:count(entry.id), groups:0, companies:0, departments:departments.filter((department) => department.branch_id === entry.id).length }, can_manage:!branchState.access.manageable_branch_ids || branchState.access.manageable_branch_ids.includes(entry.id) })),
      regions:branchState.regions.map((region) => ({ ...region, is_mine:myRegions.includes(region.id) })),
      companies_in_every_branch:1,
      access:{ see:'all', manage:'all', restricted:false, visible_branch_ids:branchState.branches.map((entry) => entry.id), manageable_branch_ids:branchState.branches.map((entry) => entry.id), can_add_branch:true, can_archive_branch:true, can_manage_regions:true, can_rename_branch_ids:branchState.branches.map((entry) => entry.id), can_set_membership:true, ...branchState.access },
      catalog_revision:branchState.revision, revision:`sha256:${branchState.revision}`
    });
  };
  window.__people.structure = structure;
  const branchAction = (action, input) => {
    const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
    if (action === 'organization-branches.branch.add') {
      if (!input.name) fail('branch_name_required');
      if (branchState.branches.some((entry) => entry.name.toLowerCase() === input.name.toLowerCase())) fail('branch_name_taken');
      const id = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      branchState.branches.push({ id, name:input.name, status:'active', is_default:false, region_id:'' });
      if (input.region_id) branchState.regions.find((region) => region.id === input.region_id).branch_ids.push(id);
    } else if (action === 'organization-branches.branch.rename') {
      const entry = branchState.branches.find((item) => item.id === input.branch_id);
      if (!input.name && !entry.is_default) fail('branch_name_required');
      if (input.name && branchState.branches.some((item) => item !== entry && item.name.toLowerCase() === input.name.toLowerCase())) fail('branch_name_taken');
      entry.name = input.name;
    } else if (action === 'organization-branches.branch.archive') {
      const entry = branchState.branches.find((item) => item.id === input.branch_id);
      if (entry.is_default) fail('default_branch_required');
      entry.status = input.archived === false ? 'active' : 'archived';
    } else if (action === 'organization-branches.region.save') {
      if (input.id) Object.assign(branchState.regions.find((region) => region.id === input.id), { label:input.label }, input.status ? { status:input.status } : {});
      else branchState.regions.push({ id:`region_${branchState.regions.length + 1}`, label:input.label, status:'active', branch_ids:[] });
    } else if (action === 'organization-branches.branch.region.set') {
      branchState.regions.forEach((region) => { region.branch_ids = region.branch_ids.filter((id) => id !== input.branch_id); });
      if (input.region_id) branchState.regions.find((region) => region.id === input.region_id).branch_ids.push(input.branch_id);
    } else if (action === 'organization-branches.membership.set') {
      const { type, id } = input.assignee;
      if (type !== 'organization_connection' && !input.branch_ids.length) fail('branch_required');
      if (window.__people.membershipDenied?.includes(id)) fail('branch_scope_denied');
      const record = type === 'organization_user' ? users.find((entry) => entry.id === id) : type === 'resource_group' ? window.__people.groups.find((entry) => entry.id === id) : window.__people.connections.find((entry) => entry.id === id);
      record.branch_ids = [...input.branch_ids];
      if (type !== 'organization_connection') record.branch_id = input.primary_branch_id || input.branch_ids[0];
      return { value:{ assignee:`${type}:${id}`, branch_ids:[...input.branch_ids], primary_branch_id:input.primary_branch_id || '' } };
    } else return null;
    branchState.revision += 1;
    return { value:structure() };
  };
  api.publication = {
    read:async (orgId, source) => {
      calls.push({ op:'read', source:`${source.provider}.${source.export}` });
      if (source.provider === 'organization-branches' && source.export === 'structure') return { status:'ready', value:structure(), revision:'r' };
      if (source.provider !== 'assignee-directory') return { status:'unavailable' };
      if (source.export === 'assignees') return { status:'ready', value:copy(directory()), revision:'r' };
      if (source.export === 'types') return { status:'ready', value:copy(types), revision:'r' };
      if (source.export === 'staffing-requirements') return { status:'ready', value:Object.entries(staffing).map(([id, list]) => ({ id:`resource_group:${id}`, assignee_id:`resource_group:${id}`, staffing_requirements:copy(list), revision:1 })), revision:'r' };
      return { status:'unavailable' };
    },
    invoke:async (orgId, action, target, input, options) => {
      calls.push({ op:'invoke', action, target:copy(target), input:copy(input), idempotencyKey:options?.idempotencyKey || '' });
      if (action.startsWith('organization-branches.')) { const done = branchAction(action, input); if (done) return done; }
      if (action === 'workforce.users.restore') { const user = users.find((entry) => entry.id === target.id); const status = user.status_before_archive === 'invited' ? 'invited' : 'active'; ['deleted', 'deleted_at', 'archived_reason', 'status_before_archive'].forEach((key) => delete user[key]); user.status = status; user.disabled = false; return { value:{ id:user.id, status, restored:true } }; }
      if (action === 'connections.onboarding.save') { const company = connections.find((entry) => entry.id === target.id); if (input.expected_revision !== company.revision) { const error = new Error('Reload and try again.'); error.code = 'organization_connection_revision_conflict'; throw error; } company.metadata = { ...(company.metadata || {}), onboarding:copy(input.onboarding) }; company.revision += 1; return { value:{ id:company.id, revision:company.revision, onboarding:copy(input.onboarding), status:{} } }; }
      if (action === 'payroll.contractor.worker.update') { const user = users.find((entry) => entry.id === target.id); Object.assign(user, { worker_classification:input.worker_classification, payment_terms:copy(input.payment_terms) }); return { value:{ id:user.id, name:user.name, worker_classification:user.worker_classification, payment_terms:copy(user.payment_terms) } }; }
      if (action === 'assignees.type.save') {
        let type = types.find((entry) => entry.id === input.id && entry.kind === input.kind);
        if (!type) { type = { id:input.id || input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), kind:input.kind, name:input.name, description:'', status:'active', member_role_ids:[] }; types.push(type); }
        Object.assign(type, { name:input.name }, input.description !== undefined ? { description:input.description } : {}, input.status ? { status:input.status } : {}, input.onboarding_requirements ? { onboarding_requirements:copy(input.onboarding_requirements) } : {});
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

function multiBranch(){
  const people = window.__people;
  people.branchState.branches = [
    { id:'default', name:'', status:'active', is_default:true, region_id:'' },
    { id:'asheville', name:'Asheville', status:'active', is_default:false, region_id:'east' },
    { id:'boone', name:'Boone', status:'active', is_default:false, region_id:'east' },
    { id:'knox', name:'Knoxville', status:'active', is_default:false, region_id:'' }
  ];
  people.branchState.regions = [{ id:'east', label:'East', status:'active', branch_ids:['asheville', 'boone'] }];
  people.branchState.my = ['asheville'];
  const place = ['asheville', 'boone', 'knox', 'default'];
  people.users.forEach((user, index) => { const branch = place[index % 4]; user.branch_id = branch; user.branch_ids = index === 8 ? [branch, 'knox'] : [branch]; });
  Object.entries({ sales:'asheville', production:'asheville', office:'default', service:'boone', warehouse:'knox' }).forEach(([id, branch]) => { people.departments.find((department) => department.id === id).branch_id = branch; });
  Object.entries({ g1:'asheville', g2:'boone', g3:'knox', g4:'asheville', g5:'default' }).forEach(([id, branch]) => { const group = people.groups.find((entry) => entry.id === id); group.branch_id = branch; group.branch_ids = [branch]; });
  Object.entries({ c1:[], c2:['asheville'], c3:['knox'], c4:['boone'] }).forEach(([id, branches]) => { people.connections.find((entry) => entry.id === id).branch_ids = branches; });
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
  await page.evaluate((catalog) => { window.__permissionCatalog = catalog; }, PERMISSION_CATALOG); await page.evaluate(stubPlatform);
  await page.evaluate(stubDirectory);
  if (options.flags) await page.evaluate((flags) => Object.assign(window.__people.flags, flags), options.flags);
  for (const setup of [].concat(options.setup || [])) await page.evaluate(setup);
  await page.addScriptTag({ url:'http://people.test/libraries/platform-ui/platform-ui.js' });
  await page.addScriptTag({ url:'http://people.test/libraries/settings-pages/firstmate-settings-pages.js' });
  for (const file of FILES) await page.addScriptTag({ url:`http://people.test/libraries/apps/people/${file}.js` });
  await page.evaluate(hoistSubtabs);
  // The shell activates the pane; People mounts itself into it.
  await page.evaluate(() => document.getElementById('csPanePeople').classList.add('active'));
  // 'direct': People opens straight onto its only (or first) page, as it does for an organization without the overview.
  if (options.view === 'direct') { await page.locator('.pp-list-body[aria-busy="false"]').first().waitFor(); return { page, errors }; }
  await page.locator('.pp-card').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.pp-card.loading'));
  if (options.view !== 'home') await openView(page, options.view || 'users');
  return { page, errors };
}
const TAB_LABELS = { home:'Overview', users:'Users', groups:'Groups', departments:'Departments', subcontractors:'Subcontractors' };
const openView = async (page, view) => { await page.locator('[data-settings-subtabs-proxy] button').filter({ hasText:new RegExp(`^\\s*${TAB_LABELS[view]}\\s*$`) }).evaluate((button) => { button.scrollIntoView({ inline:'center', block:'nearest' }); button.click(); }); if (view !== 'home') await page.locator('.pp-list-body[aria-busy="false"]').first().waitFor(); };
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

    // Rows: under a heading for each department, "No department" last; two columns of tight rows in each.
    assert.equal(await page.evaluate(() => new Set([...document.querySelectorAll('.pp-list-body .pp-row')].map((row) => row.dataset.rowKey)).size), 42);
    assert.deepEqual(await page.locator('.pp-list-section-name').allInnerTexts(), ['Office', 'Production', 'Sales', 'Service and warranty', 'Warehouse', 'No department']);
    assert.equal(await page.locator('.pp-list-body [data-row-key="u9"]').count(), 5, 'someone in five departments is listed under each');
    assert.equal(await page.locator('[data-list-section="department:service"] [data-row-key="u3"]').count(), 1);
    assert.equal(await page.locator('[data-list-section="department:production"] .pp-list-section-mark i.fa-helmet-safety').count(), 1, 'the heading carries the department icon');
    assert.equal(await page.locator('[data-list-section="department:sales"] .pp-list-section-count').innerText(), String(await page.locator('[data-list-section="department:sales"] .pp-row').count()));
    assert.equal(await columnsOf(page, '[data-list-section="department:production"] .pp-row'), 2);
    // Under a department's heading a row leaves that department out of its chips and keeps the person's others.
    const departmentChips = (selector) => page.locator(selector).evaluate((row) => [...row.querySelectorAll('.pp-chip.dot')].map((chip) => chip.textContent.trim()));
    assert.equal(await page.locator('[data-list-section="department:office"] .pp-row').evaluateAll((rows) => rows.some((row) => [...row.querySelectorAll('.pp-chip.dot')].some((chip) => chip.textContent.trim() === 'Office'))), false);
    assert.deepEqual(await departmentChips('[data-list-section="department:office"] [data-row-key="u9"]'), ['Sales', 'Production', 'Service and warranty', 'Warehouse']);
    assert.deepEqual(await departmentChips('[data-list-section="department:sales"] [data-row-key="u9"]'), ['Production', 'Office', 'Service and warranty', 'Warehouse']);
    assert.deepEqual(await departmentChips('[data-list-section="department:service"] [data-row-key="u3"]'), ['Sales']);
    const headGap = await page.evaluate(() => { const head = document.querySelector('.pp-list-head'); return document.querySelector('.pp-list-section').getBoundingClientRect().top - head.getBoundingClientRect().bottom + parseFloat(getComputedStyle(head).paddingBottom); });
    assert.ok(Math.abs(headGap - 32) <= 1, `32px under the page header (${headGap})`);

    // Sorting is per section: Name ascending by default, the active one again reverses it, and the choice is remembered.
    const sales = page.locator('[data-list-section="department:sales"]');
    const salesNames = () => sales.locator('.pp-row-name').allInnerTexts();
    const ascending = [...await salesNames()].sort((left, right) => left.localeCompare(right));
    assert.deepEqual(await salesNames(), ascending);
    assert.deepEqual(await sales.locator('.pp-list-sort').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Name', 'Role', 'Last active']);
    assert.equal(await sales.locator('[data-list-sort="name"]').getAttribute('aria-label'), 'Name, ascending');
    await sales.locator('[data-list-sort="name"]').click();
    assert.deepEqual(await salesNames(), [...ascending].reverse());
    assert.ok(await sales.locator('[data-list-sort="name"] i.fa-arrow-down').count());
    await sales.locator('[data-list-sort="role"]').click();
    assert.equal(await sales.locator('.pp-row').first().getAttribute('data-row-key'), 'u9', 'Administrator sorts first');
    await sales.locator('[data-list-sort="active"]').click();
    assert.equal(await sales.locator('[data-list-sort="active"]').getAttribute('aria-label'), 'Last active, descending', 'last active starts with the most recent');
    assert.equal(await page.locator('[data-list-section="department:production"] [data-list-sort="name"]').getAttribute('aria-pressed'), 'true', 'another section keeps its own order');
    await shot(page, 'users-sections-sorted');
    await openView(page, 'groups');
    await openView(page, 'users');
    assert.equal(await page.locator('[data-list-section="department:sales"] [data-list-sort="active"]').getAttribute('aria-pressed'), 'true', 'the choice survives the page being mounted again');
    await page.locator('[data-list-section="department:sales"] [data-list-sort="name"]').click();
    assert.deepEqual(await page.locator('[data-list-section="department:sales"] .pp-row-name').allInnerTexts(), ascending);
    assert.ok(await page.locator('.pp-row').first().evaluate((row) => row.getBoundingClientRect().height) <= 48);
    assert.equal(await page.locator('.pp-row .pp-pill.warn').count(), 3);
    assert.equal(await page.locator('.pp-row .pp-pill.warn').first().innerText(), 'Never signed in');
    assert.equal(await page.locator('.pp-row.dimmed .pp-pill.danger').innerText(), 'Suspended');
    const manyRoles = page.locator('[data-row-key="u9"]').first();
    assert.equal(await manyRoles.locator('.pp-chip.role.more').innerText().then((text) => /^\+\d$/.test(text)), true);
    assert.ok(await manyRoles.evaluate((row) => row.scrollWidth <= row.clientWidth + 1), 'a row with many roles and departments does not overflow');
    assert.ok(await page.locator('[data-row-key="u8"]').evaluate((row) => row.scrollWidth <= row.clientWidth + 1), 'a long name truncates');

    // Presence arrives on the platform channel and lights the dot.
    assert.equal(await page.locator('[data-row-key="u2"] .pp-online').isHidden(), true);
    await page.evaluate(() => window.__people.presence([{ user_id:'u2', status:'active' }, { user_id:'u3', status:'away' }, { user_id:'u9', status:'active' }, { user_id:'u14', status:'active' }, { user_id:'u21', status:'active' }]));
    assert.equal(await page.locator('[data-row-key="u2"] .pp-online').isVisible(), true);
    assert.equal(await page.locator('[data-row-key="u3"] .pp-online').first().getAttribute('data-status'), 'away');
    assert.equal(await page.locator('[data-row-key="u5"] .pp-online').isHidden(), true);
    await shot(page, 'users-desktop');

    // Search.
    await page.locator('[data-list-search]').fill('foreman');
    await page.waitForFunction(() => new Set([...document.querySelectorAll('.pp-list-body .pp-row')].map((row) => row.dataset.rowKey)).size < 42);
    assert.match(await page.locator('.pp-list-sub').innerText(), /^\d+ of 42 users/);
    await page.locator('[data-list-search]').fill('zzzz');
    await page.locator('.pp-list-state').waitFor();
    await shot(page, 'users-empty-search');
    await page.locator('[data-list-search]').fill('');
    await page.waitForFunction(() => new Set([...document.querySelectorAll('.pp-list-body .pp-row')].map((row) => row.dataset.rowKey)).size === 42);

    // Hover card: opens after a short delay, is read-only and never focusable.
    await page.locator('[data-row-key="u9"] .pp-row-name').first().hover();
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
    assert.deepEqual(await page.locator('[data-row-key="u5"] .pp-row-actions button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))), ['Edit', 'Resend invitation', 'Suspend', 'Revoke invitation']);
    await shot(page, 'row-quick-actions');
    await page.locator('[data-row-key="u5"] [data-row-action="invite"]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'resendInvite' && call.id === 'u5'));

    // Open a user: the large modal, summary left, tabs right.
    await page.locator('[data-row-key="u3"] .pp-row-name').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.deepEqual(await dialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim().replace(/\s+\d+$/, '')).filter((text) => text !== 'Pay sheets')), ['Permissions', 'App experience', 'Compensation', 'Fields', 'Activity']);
    assert.ok(await page.evaluate(() => document.querySelector('.pp-modal').contains(document.activeElement)), 'focus moves into the modal');
    assert.match(await dialog.locator('[data-section="roles"]').innerText(), /Sales/);
    assert.match(await dialog.locator('[data-section="departments"]').innerText(), /Sales[\s\S]*Service and warranty/, 'departments in the order they are organized');
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

    // Categories on the left with their override counts, subcategories as headings on the right; titles are labels, descriptions tooltips.
    const headings = () => dialog.locator('.pp-perm-heading').evaluateAll((nodes) => nodes.map((node) => node.textContent));
    assert.deepEqual(await dialog.locator('[data-perm-group]').evaluateAll((buttons) => buttons.map((button) => button.dataset.permGroup)), ['company', 'people', 'sales', 'projects', 'scheduling', 'field', 'materials', 'money', 'communications', 'documents', 'partners', 'other']);
    assert.equal(await dialog.locator('[data-perm-group="sales"] .pp-perm-group-count').innerText(), '2');
    assert.deepEqual(await headings(), ['Contacts', 'Sales pipeline', 'Canvassing', 'Customer portals', 'Customer feedback', 'Websites', 'Sales app', 'Proposals (legacy)']);
    assert.equal(await followups.locator('.pp-perm-label').innerText(), 'Manage own follow-ups');
    assert.match(await followups.locator('.pp-perm-label').getAttribute('data-fm-tooltip'), /^Create, claim and resolve their own follow-ups/);
    await dialog.locator('[data-perm-group="field"]').click();
    assert.deepEqual(await headings(), ['Field app', 'Checklists', 'Time & expenses', 'Payments & signatures', 'Materials & change orders']);
    // Search looks across every category and names the category beside the subcategory.
    await dialog.locator('[data-perm-search]').fill('checklist');
    assert.deepEqual(await headings(), ['Field workChecklists']);
    assert.equal(await dialog.locator('.pp-perm-row').count(), 4);
    await dialog.locator('[data-perm-search]').fill('');
    // Older permission names are folded at the end of their category until opened; search still finds them.
    await dialog.locator('[data-perm-group="company"]').click();
    const fold = dialog.locator('[data-perm-fold="company/older_names"]');
    assert.equal(await fold.getAttribute('aria-expanded'), 'false');
    assert.equal(await dialog.locator('[data-perm-key="manage_organization"]').count(), 0);
    assert.equal(await dialog.locator('.pp-perm-list > *').last().getAttribute('data-perm-fold'), 'company/older_names', 'the fold is last');
    await fold.click();
    assert.equal(await dialog.locator('[data-perm-fold="company/older_names"]').getAttribute('aria-expanded'), 'true');
    assert.equal(await dialog.locator('[data-perm-key="manage_organization"]').count(), 1);
    assert.ok(await dialog.locator('.pp-perm-label').evaluateAll((labels) => labels.every((label) => label.scrollHeight <= label.clientHeight + 1)), 'labels wrap instead of truncating');
    await shot(page, 'user-modal-permissions-company');
    await dialog.locator('[data-perm-fold="company/older_names"]').click();
    await dialog.locator('[data-perm-search]').fill('older name');
    assert.equal(await dialog.locator('.pp-perm-row').count(), 4);
    await dialog.locator('[data-perm-search]').fill('');
    // A permission whose app is off is muted, not hidden; a key the catalog does not know is listed under Other.
    await dialog.locator('[data-perm-group="materials"]').click();
    assert.match(await dialog.locator('[data-perm-key="equipment.view"]').getAttribute('class'), /unavailable/);
    assert.doesNotMatch(await dialog.locator('[data-perm-key="view_pricebook"]').getAttribute('class'), /unavailable/);
    await dialog.locator('[data-perm-group="other"]').click();
    assert.equal(await dialog.locator('[data-perm-key="use_phone"] .pp-perm-label').innerText(), 'Use phone');

    // Changing a role changes what is inherited.
    await dialog.locator('[data-perm-group="field"]').click();
    assert.doesNotMatch(await dialog.locator('[data-perm-key="crew.receipts.upload"]').getAttribute('class'), /allowed/);
    await dialog.locator('[data-people-section-action="roles"]').click();
    await page.getByRole('menuitemcheckbox', { name:'Foreman' }).click();
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true, 'Escape closes the menu, not the modal');
    assert.match(await dialog.locator('[data-section="roles"]').innerText(), /Foreman/);
    assert.match(await dialog.locator('[data-perm-key="crew.receipts.upload"]').getAttribute('class'), /allowed/);
    assert.doesNotMatch(await dialog.locator('[data-perm-key="crew.receipts.upload"]').getAttribute('class'), /overridden/);

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
    assert.equal(await dialog.locator('[data-apps-id="portal.calls"] [data-apps-cell="mobile"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await dialog.locator('[data-apps-id="portal.calls"] [data-apps-cell="desktop"]').getAttribute('aria-pressed'), 'true', 'each device is set on its own');
    // An option is a line under its app, separate from devices and permissions.
    const clock = dialog.locator('[data-apps-id="portal.crew_overview"] [data-apps-option="time_clock"]');
    assert.equal(await clock.getAttribute('aria-checked'), 'false');
    await clock.click();
    assert.equal(await dialog.locator('[data-apps-id="portal.crew_overview"] [data-apps-option="time_clock"]').getAttribute('aria-checked'), 'true');
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
    assert.deepEqual(saved.profile.app_access_overrides, { 'portal.calls':{ visible:{ mobile:false } }, 'portal.crew_overview':{ options:{ time_clock:true } } });
    assert.equal(saved.profile.application_access, undefined);
    assert.equal(saved.slot, true);

    // Unsaved changes are confirmed; Escape closes and focus returns to the row.
    await dialog.getByRole('tab', { name:'Permissions' }).click();
    await dialog.locator('[data-perm-group="company"]').click();
    await dialog.locator('[data-perm-key="manage_billing"] [data-choice="allow"]').click();
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor();
    await page.getByRole('button', { name:'Discard' }).click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.pp-row')?.dataset.rowKey), 'u3');
    assert.match(await page.locator('[data-row-key="u3"]').first().innerText(), /Foreman/);

    // Roles: the header button opens the large list, like types and tags; a row opens the role over it.
    await page.locator('[data-list-action="0"]').click();
    const rolesList = page.getByRole('dialog', { name:'Roles' });
    await rolesList.waitFor();
    assert.equal(await rolesList.locator('.pp-type').count(), 7, 'every active role is a row');
    assert.equal(await rolesList.locator('[data-type-id="sales"] .pp-type-open').getAttribute('data-fm-tooltip'), 'Sells and follows up', 'the description is the name tooltip');
    assert.match(await rolesList.locator('[data-type-id="admin"]').innerText(), /Administrator[\s\S]*Built-in/);
    assert.match(await rolesList.locator('[data-type-id="sales"]').innerText(), /Sales[\s\S]*Custom/);
    assert.ok(await rolesList.locator('[data-type-id="sales"] .pp-type-faces .pp-avatar').count() >= 1, 'a few member faces');
    assert.equal(await rolesList.locator('[data-type-id="sales"] .pp-stack-count').innerText(), String(await page.evaluate(() => window.FirstMatePeople.data.roleMembers('sales').length)));
    assert.equal(await rolesList.locator('[data-type-id="admin"] [data-list-row-action="archive"]').isDisabled(), true, 'a built-in role cannot be archived');
    assert.equal(await rolesList.locator('[data-type-id="sales"] [data-list-row-action="archive"]').isDisabled(), false);
    assert.equal(await rolesList.locator('[data-list-new]').innerText(), 'New role');
    await shot(page, 'roles-list');
    await rolesList.locator('[data-type-id="sales"] .pp-type-open').click();
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

    // Duplicate copies permissions and app defaults under a new name; Archive asks first.
    await page.locator('[data-list-action="0"]').click();
    await rolesList.waitFor();
    await rolesList.locator('[data-type-id="sales"] [data-list-row-action="duplicate"]').click();
    assert.equal(await page.locator('.pp-form [name="name"]').inputValue(), 'Sales copy');
    await page.locator('.pp-form [type="submit"]').click();
    await rolesList.locator('.pp-type', { hasText:'Sales copy' }).waitFor();
    const copied = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'createAccessRole' || call.op === 'updateAccessRole').slice(-2));
    assert.equal(copied[0].op, 'createAccessRole');
    assert.equal(copied[0].role.name, 'Sales copy');
    assert.equal(copied[0].role.application_ids, undefined);
    assert.equal(copied[1].patch.permissions['sales.stats.view_team'], true, 'the copy has the permissions');
    assert.equal(copied[1].patch.description, 'Sells and follows up');
    const copyId = copied[1].id;
    await rolesList.locator(`[data-type-id="${copyId}"] [data-list-row-action="archive"]`).click();
    await page.getByRole('alertdialog').getByRole('button', { name:'Archive' }).click();
    await page.waitForFunction((id) => window.__people.calls.some((call) => call.op === 'archiveAccessRole' && call.id === id), copyId);
    await rolesList.locator(`[data-type-id="${copyId}"]`).waitFor({ state:'detached' });
    await rolesList.locator('[data-modal-close]').click();
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

    // Suspend and archive from the row.
    await page.locator('[data-row-key="u20"]').hover();
    await page.locator('[data-row-key="u20"] [data-row-action="suspend"]').click();
    await page.locator('[data-row-key="u20"].dimmed').waitFor();
    assert.equal(await page.locator('[data-row-key="u20"] .pp-pill.danger').innerText(), 'Suspended');
    assert.equal(await page.locator('.pp-list-sub').innerText(), '43 users, 4 never signed in, 2 suspended');
    assert.equal(await page.locator('[data-row-key="u1"] [data-row-action="suspend"]').isDisabled(), true, 'you cannot suspend yourself');
    await page.locator('[data-row-key="u21"]').hover();
    await page.locator('[data-row-key="u21"] [data-row-action="archive"]').click();
    await page.locator('.pp-form .pp-form-note').waitFor();
    await page.locator('.pp-form [type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-list-body [data-row-key="u21"]'));

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
    await page.locator('[data-row-key="u9"] .pp-row-name').first().click();
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
    // Permissions at phone width: categories become a scrolling row of chips above one column of subcategories.
    await dialog.getByRole('tab', { name:'Permissions' }).click();
    await dialog.locator('[data-perm-group="sales"]').evaluate((button) => { button.scrollIntoView({ inline:'center', block:'nearest' }); button.click(); });
    assert.equal(await dialog.locator('.pp-perm-groups').evaluate((row) => getComputedStyle(row).flexDirection), 'row');
    assert.equal(await columnsOf(page, '.pp-perm-row'), 1);
    assert.ok(await dialog.locator('.pp-perm-heading').count() >= 5, 'subcategory headings show at phone width');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(page, 'user-modal-phone-permissions');
    await page.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    await page.locator('[data-list-action="0"]').click();
    await page.getByRole('dialog', { name:'Roles' }).locator('[data-type-id="sales"] .pp-type-open').click();
    const roleDialog = page.getByRole('dialog', { name:'Sales' });
    await roleDialog.waitFor();
    await roleDialog.locator('[data-perm-group="field"]').evaluate((button) => { button.scrollIntoView({ inline:'center', block:'nearest' }); button.click(); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(page, 'role-modal-phone-permissions');
    await roleDialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    await page.locator('[data-list-action="0"]').click();
    const rolesPhone = page.getByRole('dialog', { name:'Roles' });
    await rolesPhone.locator('.pp-type').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(page, 'roles-list-phone');
    await rolesPhone.locator('[data-modal-close]').click();
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
    await page.evaluate((catalog) => { window.__permissionCatalog = catalog; }, PERMISSION_CATALOG); await page.evaluate(stubPlatform);
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
    assert.deepEqual(await page.locator('.pp-list-section-name').allInnerTexts(), ['Install crews', 'Sales teams', 'Service teams']);
    assert.equal(await page.locator('.pp-list-section').first().locator('[data-row-key="g1"]').count(), 1);
    assert.equal(await north.locator('.pp-pill').count(), 0);
    assert.equal(await north.locator('.pp-stack-count').innerText(), '7');
    assert.equal(await north.locator('.pp-stack .pp-avatar').count(), 4);
    assert.match(await north.locator('.pp-row-chips').innerText(), /Production/);
    assert.ok(await page.locator('[data-row-key="g4"]').evaluate((row) => row.scrollWidth <= row.clientWidth + 1 && row.getBoundingClientRect().height <= 48), 'a long group name stays on one tight row');
    assert.equal(await page.locator('.pp-row').evaluateAll((rows) => rows.every((row) => row.getBoundingClientRect().height <= 48)), true);

    // Each section sorts on its own: Name (the default), Members, Department; the active one again reverses it.
    const crews = page.locator('[data-list-section="crew"]');
    const crewOrder = () => crews.locator('.pp-row').evaluateAll((rows) => rows.map((row) => row.dataset.rowKey));
    assert.deepEqual(await crews.locator('.pp-list-sort').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Name', 'Members', 'Department']);
    assert.equal(await crews.locator('[data-list-sort="name"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await crewOrder(), ['g1', 'g3']);
    await crews.locator('[data-list-sort="members"]').click();
    assert.equal(await crews.locator('[data-list-sort="members"]').getAttribute('aria-label'), 'Members, descending');
    assert.ok(await crews.locator('[data-list-sort="members"] i.fa-arrow-down').count(), 'the arrow shows the direction');
    assert.deepEqual(await crewOrder(), ['g1', 'g3'], 'most members first');
    await crews.locator('[data-list-sort="members"]').click();
    assert.deepEqual(await crewOrder(), ['g3', 'g1'], 'clicking again reverses it');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.listSort), 'members', 'focus stays on the sort');
    assert.equal(await page.locator('[data-list-section="sales_team"] [data-list-sort="name"]').getAttribute('aria-pressed'), 'true', 'another section keeps its own order');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('fm.people.list-sort.groups'))), { crew:{ id:'members', dir:'asc' } });
    await shot(page, 'groups-sorted');
    await crews.locator('[data-list-sort="name"]').click();
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
    assert.deepEqual(await dialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim().replace(/\s+\d+$/, '')).filter((text) => text !== 'Pay sheets')), ['Members', 'Staffing requirements', 'App experience', 'Compensation', 'Fields']);
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
    assert.ok(Number(await production.locator('.pp-stack-count').first().innerText()) > 5);
    await shot(page, 'departments-desktop');

    await production.locator('.pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'Production' });
    await dialog.waitFor();
    assert.deepEqual(await dialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Members', 'App experience', 'Roles in Production', 'Fields']);
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

    // Roles held only for work in this department are saved on the user; the tab names the department.
    await dialog.locator('.pp-tab', { hasText:'Roles in Production' }).click();
    assert.equal(await dialog.locator('.pp-modal-panel:not([hidden]) [data-list-action="0"]').innerText(), 'Give a role in Production');
    await dialog.locator('.pp-modal-panel:not([hidden]) [data-list-action="0"]').click();
    await page.locator('.pp-form [name="userId"]').selectOption('u6');
    assert.equal(await page.locator('.pp-form [name="roleId"] option', { hasText:'Administrator' }).count(), 0, 'roles that administer the organization cannot be scoped');
    await page.locator('.pp-form [name="roleId"]').selectOption('production');
    await page.locator('.pp-form [type="submit"]').click();
    await dialog.locator('.pp-modal-panel:not([hidden]) [data-row-key="u6"]').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveUserProfile' && call.id === 'u6').pop().profile.scoped_access_assignments), [{ role_id:'production', scope:{ kind:'department', id:'production' } }]);
    // Each person's row has its own Roles button, opening the same picker titled with the department.
    const u6 = dialog.locator('.pp-modal-panel:not([hidden]) [data-row-key="u6"]');
    await u6.hover();
    assert.equal(await u6.locator('[data-row-action="roles"]').getAttribute('aria-label'), 'Change Farid Nair’s roles in Production');
    await u6.locator('[data-row-action="roles"]').click();
    const picker = page.getByRole('menu', { name:'Roles in Production' });
    await picker.waitFor();
    assert.equal(await picker.getByRole('menuitemcheckbox', { name:'Production' }).getAttribute('aria-checked'), 'true');
    await picker.getByRole('menuitemcheckbox', { name:'Installer' }).click();
    await page.waitForFunction(() => (window.__people.calls.filter((call) => call.op === 'saveUserProfile' && call.id === 'u6').pop()?.profile.scoped_access_assignments || []).length === 2);
    await shot(page, 'department-modal-roles-picker');
    await page.keyboard.press('Escape');
    await dialog.locator('.pp-modal-panel:not([hidden]) [data-row-key="u6"] .pp-chip', { hasText:'Installer' }).waitFor();
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

    await page.locator('[data-list-action="0"]').click();
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
    assert.deepEqual(await dialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim().replace(/\s+\d+$/, '')).filter((text) => text !== 'Pay sheets')), ['Overview', 'Onboarding', 'Link', 'Payment terms', 'Compensation', 'Fields']);
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

// Several branches, and u9 holds roles in a department, in the East region and in the Knoxville branch.
function branchRoles(){
  window.__people.users.find((user) => user.id === 'u9').scoped_access_assignments = [{ role_id:'crew_foreman', scope:{ kind:'department', id:'production' } }, { role_id:'crew_member', scope:{ kind:'region', id:'east' } }, { role_id:'phones', scope:{ kind:'branch', id:'knox' } }];
}

test('User modal: departments under their branch and region, each place with its own roles, at desktop and phone width', async () => {
  const browser = await launch();
  try {
    for (const [width, height, suffix] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
      const { page, errors } = await openPage(browser, { width, height }, { setup:[multiBranch, branchRoles] });
      await page.locator('[data-row-key="u9"] .pp-row-name').first().click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      if (suffix === 'phone') { await page.locator('[data-modal-summary-toggle]').click(); await dialog.locator('[data-section="departments"]').scrollIntoViewIfNeeded(); }
      const section = dialog.locator('[data-section="departments"]');
      const outline = await section.locator('.pp-dtree-item').evaluateAll((items) => items.map((item) => `${item.style.getPropertyValue('--depth')}:${item.querySelector('.pp-dtree-name').textContent}`));
      assert.deepEqual(outline, ['0:East', '1:Asheville', '2:Production', '2:Sales', '1:Boone', '2:Service and warranty', '0:Knoxville', '1:Warehouse', '0:Main branch', '1:Office']);
      const production = section.locator('[data-dtree="department:production"]');
      assert.match(await production.innerText(), /Production[\s\S]*Foreman/);
      assert.equal(await production.locator('[data-dtree-roles]').getAttribute('aria-label'), 'Roles in Production');
      assert.equal(await production.locator('.pp-dtree-via').getAttribute('aria-label'), 'In Production through the Production role');
      assert.match(await section.locator('[data-dtree="region:east"]').innerText(), /East[\s\S]*Installer/);
      assert.match(await section.locator('[data-dtree="branch:knox"]').innerText(), /Knoxville[\s\S]*Phones/);
      assert.equal(await section.locator('[data-dtree="branch:asheville"] [data-dtree-roles]').getAttribute('aria-label'), 'Roles in Asheville');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scrolling');
      const fits = await section.locator('.pp-dtree-line').evaluateAll((lines) => lines.every((line) => line.scrollWidth <= line.clientWidth + 1));
      assert.ok(fits, 'every line fits its column');
      await shot(page, `user-modal-branches-${suffix}`);

      await section.locator('[data-dtree="region:east"] [data-dtree-roles]').click();
      await page.getByRole('menu', { name:'Roles in East' }).waitFor();
      assert.equal(await page.locator('.pp-menu-title .pp-info').getAttribute('data-fm-tooltip'), 'These apply only to work in the branches of East.');
      assert.equal(await page.getByRole('menuitemcheckbox', { name:'Installer' }).getAttribute('aria-checked'), 'true');
      await page.keyboard.press('Escape');
      await production.locator('[data-dtree-roles]').click();
      const picker = page.getByRole('menu', { name:'Roles in Production' });
      await picker.waitFor();
      await picker.getByRole('menuitemcheckbox', { name:'Installer' }).click();
      const box = await page.locator('.pp-menu').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, 'the picker stays on screen');
      await shot(page, `user-modal-roles-picker-${suffix}`);
      await page.keyboard.press('Escape');

      if (suffix === 'desktop') {
        await section.locator('[data-dtree="department:service"] .pp-dtree-remove').click();
        await dialog.locator('[data-modal-save]').click();
        await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
        const saved = await page.evaluate(() => ({ departments:window.__people.calls.filter((call) => call.op === 'saveDepartmentAssignment').pop().payload, scoped:window.__people.calls.filter((call) => call.op === 'saveUserProfile' && call.id === 'u9').pop().profile.scoped_access_assignments }));
        assert.deepEqual(saved.departments.department_ids, ['warehouse']);
        assert.deepEqual(saved.scoped, [{ role_id:'crew_member', scope:{ kind:'region', id:'east' } }, { role_id:'phones', scope:{ kind:'branch', id:'knox' } }, { role_id:'crew_foreman', scope:{ kind:'department', id:'production' } }, { role_id:'crew_member', scope:{ kind:'department', id:'production' } }], 'branch and region roles are kept');
        await dialog.locator('[data-modal-close]').click();
        await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
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
    // Departments are added in the Departments section; each one has its own Roles button, titled with it.
    const departments = dialog.locator('[data-section="departments"]');
    assert.equal(await dialog.locator('[data-section="roles"] h4').textContent(), 'Roles everywhere');
    assert.equal(await departments.locator('[data-dtree="department:sales"] .pp-dtree-remove').count(), 0, 'a department held through a role is not removed here');
    await departments.locator('[data-people-section-action="departments"]').click();
    await page.getByRole('menuitemcheckbox', { name:'Service and warranty' }).click();
    await page.keyboard.press('Escape');
    const service = departments.locator('[data-dtree="department:service"]');
    assert.equal(await service.locator('[data-dtree-roles]').getAttribute('aria-label'), 'Roles in Service and warranty');
    await service.locator('[data-dtree-roles]').click();
    const picker = page.getByRole('menu', { name:'Roles in Service and warranty' });
    await picker.waitFor();
    assert.equal(await page.locator('.pp-menu-title strong').innerText(), 'Roles in Service and warranty');
    assert.equal(await page.locator('.pp-menu-title .pp-info').getAttribute('data-fm-tooltip'), 'These apply only to work in Service and warranty.');
    assert.equal(await picker.getByRole('menuitemcheckbox', { name:/^Administrator/ }).count(), 0, 'roles that administer the organization cannot be held in one department');
    assert.equal(await picker.getByRole('menuitemcheckbox', { name:/^Sales/ }).isDisabled(), true, 'a role held everywhere is not given again');
    await picker.getByRole('menuitemcheckbox', { name:'Production' }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.dtreeRoles), 'department:service', 'focus returns to the Roles button');
    assert.match(await service.innerText(), /Service and warranty[\s\S]*Production/);
    await shot(page, 'user-modal-tags-scoped-roles');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    const profile = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveUserProfile' && call.id === 'u4').pop().profile);
    assert.deepEqual(profile.assignment_tag_ids, ['bilingual']);
    assert.deepEqual(profile.scoped_access_assignments, [{ role_id:'production', scope:{ kind:'department', id:'service' } }]);
    assert.equal(profile.access_role_ids, undefined, 'roles are not rewritten when only tags change');
    assert.deepEqual(await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveDepartmentAssignment' && call.payload.id === 'u4').pop().payload.department_ids), ['service']);

    // Leaving a department drops the roles held only there.
    await service.locator('.pp-dtree-remove').click();
    assert.equal(await service.count(), 0);
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => window.__people.calls.filter((call) => call.op === 'saveDepartmentAssignment' && call.payload.id === 'u4').pop().payload.department_ids.length === 0);
    assert.deepEqual(await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveUserProfile' && call.id === 'u4').pop().profile.scoped_access_assignments), []);
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
    await page.evaluate((catalog) => { window.__permissionCatalog = catalog; }, PERMISSION_CATALOG); await page.evaluate(stubPlatform);
    await page.evaluate(stubDirectory);
    await page.evaluate(() => {
      // What the portal gives every app, reduced to what the Settings shell reads.
      const on = new Set(['platform.people_access', 'platform.expanded_access', 'platform.my_settings', 'platform.custom_fields', 'apps.payroll', 'apps.crew']);
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
    for (const file of ['platform-ui/platform-ui.js', 'settings-pages/firstmate-settings-pages.js', 'apps/settings/search-index.js', 'apps/settings/search.js', 'priority-fields/priority-fields.js', ...bundles].filter(present)) await page.addScriptTag({ url:`http://people.test/libraries/${file}` });
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
    // Scrolled, the stuck header covers everything up to the top of its card and fades into the rows.
    const covered = await page.evaluate(async () => {
      const list = document.querySelector('#csPanePeople .pp-list');
      let scroller = list.parentElement;
      while (scroller && scroller !== document.body && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const target = scroller && scroller !== document.body ? scroller : document.scrollingElement;
      target.scrollTop = 420;
      target.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const head = list.querySelector('.pp-list-head');
      const headTop = head.getBoundingClientRect().top;
      const card = list.closest('.cs-card') || target;
      const cardTop = card === document.scrollingElement ? 0 : card.getBoundingClientRect().top + card.clientTop;
      const cover = parseFloat(getComputedStyle(head, '::before').height) || 0;
      return { stuck:head.classList.contains('stuck'), gap:Math.round(headTop - cardTop), cover:Math.round(cover), fade:getComputedStyle(head, '::after').opacity };
    });
    assert.equal(covered.stuck, true, 'the header is stuck over scrolled rows');
    assert.ok(covered.cover >= covered.gap, `the header covers the ${covered.gap}px above it (cover ${covered.cover}px)`);
    assert.equal(covered.fade, '1');
    await shot(page, 'real-shell-users-scrolled');
    await page.evaluate(() => { document.querySelectorAll('*').forEach((node) => { if (node.scrollTop) node.scrollTop = 0; }); });
    await page.locator('#csPanePeople [data-row-key="u9"] .pp-row-name').first().click();
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

test('Users: status filter chips, photo at invite, activity, and roles held in one department', async () => {
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
    assert.deepEqual(await page.locator('.pp-row [data-row-action]').evaluateAll((buttons) => buttons.map((button) => button.dataset.rowAction)), ['restore'], 'an archived person is shown for the record, and can be restored');
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

    // Activity, and a role held only in one department.
    await page.locator('[data-row-key="u4"] .pp-row-name').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.pp-tab', { hasText:'Activity' }).click();
    await dialog.locator('.pp-activity li').first().waitFor();
    assert.equal(await dialog.locator('.pp-activity li').count(), 3);
    assert.match(await dialog.locator('.pp-activity').innerText(), /Uploaded 4 photos to 18 Maple Court/);
    assert.equal(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'activity').user), 'u4');
    await shot(page, 'user-modal-activity');
    // One branch: the department stands alone, with no branch or region above it.
    const departments = dialog.locator('[data-section="departments"]');
    assert.deepEqual(await departments.locator('.pp-dtree-item .pp-dtree-name').allInnerTexts(), ['Sales']);
    assert.equal(await departments.locator('[data-dtree^="branch:"], [data-dtree^="region:"]').count(), 0);
    await departments.locator('[data-dtree="department:sales"] [data-dtree-roles]').click();
    await page.getByRole('menuitemcheckbox', { name:'Foreman' }).click();
    await page.keyboard.press('Escape');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    assert.deepEqual(await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveUserProfile' && call.id === 'u4').pop().profile.scoped_access_assignments), [{ role_id:'crew_foreman', scope:{ kind:'department', id:'sales' } }]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Departments: no units or categories, the channel switch, app visibility and a strict save', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'departments' });
    assert.deepEqual(await page.locator('.pp-list-tools .pp-btn').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['New department']);
    assert.equal(await page.locator('.pp-list-section').count(), 0, 'one branch: departments are not sectioned');
    await page.locator('.pp-list-body [data-row-key="office"] .pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'Office' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('[data-people-identity]').getAttribute('aria-label'), 'Edit name');
    await dialog.locator('[data-people-identity]').click();
    assert.equal(await dialog.locator('select[data-identity]').count(), 0, 'no category, unit or branch to pick');
    await dialog.locator('[data-dept-channel]').click();
    await dialog.locator('.pp-tab', { hasText:'App experience' }).click();
    assert.ok(await columnsOf(page, '.pp-app') >= 2);
    await dialog.locator('[data-apps-id="portal.payroll"] [data-apps-cell="desktop"]').click();
    await shot(page, 'department-modal-app-visibility');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    const payload = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveDepartments').pop().payload);
    assert.deepEqual(Object.keys(payload).sort(), ['departments', 'revision', 'terminology']);
    const allowed = ['id', 'label', 'color', 'icon', 'branch_id', 'status', 'default_channel', 'app_defaults', 'subject_keys', 'role_ids', 'group_kind_ids'];
    assert.ok(payload.departments.every((entry) => Object.keys(entry).every((key) => allowed.includes(key))), 'no group_id or division_id');
    const saved = payload.departments.find((entry) => entry.id === 'office');
    assert.equal(saved.default_channel, false);
    assert.equal(saved.branch_id, 'default', 'an existing department keeps the branch it was read with');
    assert.deepEqual(saved.app_defaults, { 'portal.payroll':{ visible:{ desktop:true } } }, 'Payroll is hidden by default; the department shows it on desktop');
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
  await page.evaluate((catalog) => { window.__permissionCatalog = catalog; }, PERMISSION_CATALOG); await page.evaluate(stubPlatform);
  await page.evaluate(stubDirectory);
  await page.evaluate((startView) => {
    const on = new Set(['platform.people_access', 'platform.expanded_access', 'platform.my_settings', 'platform.custom_fields', 'apps.payroll', 'apps.crew']);
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
  for (const file of ['platform-ui/platform-ui.js', 'settings-pages/firstmate-settings-pages.js', 'apps/settings/search-index.js', 'apps/settings/search.js', 'priority-fields/priority-fields.js', ...bundles].filter(present)) await page.addScriptTag({ url:`http://people.test/libraries/${file}` });
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
    await page.locator('#csPanePeople [data-row-key="u3"] .pp-row-name').first().click();
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
    await page.getByRole('dialog', { name:'Roles' }).locator('[data-type-id="sales"] .pp-type-open').click();
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
    await phone.page.locator('#csPanePeople [data-row-key="u3"] .pp-row-name').first().click();
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
    await dialog.locator('[data-perm-group="field"]').click();
    assert.match(await dialog.locator('[data-perm-key="crew.payments.take"]').getAttribute('class'), /overridden/);
    assert.match(await dialog.locator('[data-perm-key="crew.schedule.view"]').getAttribute('class'), /allowed/);
    assert.match(await dialog.locator('.pp-company-perm .pp-info').getAttribute('aria-label'), /does not change anyone's access yet/);
    await dialog.locator('[data-perm-key="crew.receipts.upload"] [data-choice="deny"]').click();
    await shot(page, 'subcontractor-modal-permissions');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.action === 'assignees.permission-defaults.set'));
    assert.deepEqual(await page.evaluate(() => window.__people.calls.find((call) => call.action === 'assignees.permission-defaults.set').input), { assignee:{ type:'organization_connection', id:'c1' }, access_role_ids:['crew_member'], permission_overrides:{ 'crew.payments.take':false, 'crew.receipts.upload':false } });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

// An organization on the original FirstMeasure model: no platform.people_access, no platform.expanded_access, none of
// the apps People's other pages need, and a user who may manage users and their permissions and nothing else.
const FIRSTMEASURE_ONLY = {
  view:'direct',
  flags:{ 'platform.people_access':false, 'platform.expanded_access':false, 'apps.crew':false, 'apps.payroll':false, 'platform.custom_fields':false },
  setup:() => {
    window.Portal.util.hasPerm = (key) => ['manage_company_users', 'manage_company_user_permissions'].includes(key);
    // Anything on a surface this organization does not have is recorded: the page must never call it.
    window.__people.denied = [];
    const watch = (name, target) => Object.keys(target || {}).forEach((key) => { const original = target[key]; if (typeof original === 'function') target[key] = (...args) => { window.__people.denied.push(`${name}.${key}`); return original(...args); }; });
    watch('workforce', window.PlatformAPI.workforce);
    watch('connections', window.PlatformAPI.connections);
    watch('publication', window.PlatformAPI.publication);
    watch('scopes', window.PlatformAPI.scopes);
  }
};

test('FirstMeasure-only organization: People is Users alone, with only what the original model supports', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, FIRSTMEASURE_ONLY);
    assert.equal(await page.locator('.pp-list-head h2').innerText(), 'Users');
    assert.equal(await page.locator('.fm-settings-subtabs, [data-settings-subtabs-proxy]').count(), 0, 'no sub-tab bar and no Overview');
    assert.equal(await page.locator('.pp-card').count(), 0);
    assert.deepEqual(await page.locator('.pp-list-tools .pp-btn').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Invite user'], 'no Roles menu without roles');
    assert.equal(await page.locator('[data-row-key="u2"] .pp-chip.role').first().innerText(), 'Viewer', 'the admin level stands where roles would');
    assert.equal(await page.locator('.pp-row .pp-chip-dot').count(), 0, 'no departments');
    assert.equal(await page.locator('[data-name-mark]').count(), 0, 'no contractor icon without payroll');
    await page.locator('[data-row-key="u5"]').hover();
    assert.deepEqual(await page.locator('[data-row-key="u5"] .pp-row-actions button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))), ['Edit', 'Resend invitation', 'Suspend', 'Revoke invitation']);
    await shot(page, 'firstmeasure-only-users');
    await page.locator('[data-row-key="u9"] .pp-row-name').hover();
    await page.locator('.pp-hover.open').waitFor();
    assert.equal(await page.locator('.pp-hover [data-section]').count(), 0, 'the hover card names no roles, departments or groups');
    await page.mouse.move(700, 5);

    // The user modal: the seven-flag editor and the activity record; nothing that needs roles, departments, pay or fields.
    await page.locator('[data-row-key="u2"] .pp-row-name').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.deepEqual(await dialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Permissions', 'Activity']);
    assert.equal(await dialog.locator('[data-people-section-action]').count(), 0, 'no roles, departments, tags or scoped roles to change');
    assert.equal(await dialog.locator('[data-section]').count(), 0);
    assert.equal(await dialog.locator('.pp-perm-row').count(), 7);
    await dialog.locator('[data-legacy-level]').selectOption('manager');
    await shot(page, 'firstmeasure-only-user-modal');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'setPermissions'));
    assert.equal(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'setPermissions').level), 'manager');
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));

    // Inviting asks only for who; no roles to pick and no workforce profile written.
    await page.locator('[data-list-action="0"]').click();
    assert.equal(await page.locator('.pp-form .pp-choice').count(), 0);
    await page.locator('.pp-form [name="email"]').fill('lena@northwind-exteriors.example');
    await shot(page, 'firstmeasure-only-invite');
    await page.locator('.pp-form [type="submit"]').click();
    await page.locator('[data-row-key="u43"]').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__people.denied), [], 'nothing was asked of workforce, connections, publication or scopes');
    assert.equal(await page.evaluate(() => window.__people.toasts.filter((toast) => toast.ok === false).length), 0, 'no refusal reached the user');
    assert.deepEqual(await page.evaluate(() => window.FirstMatePeople.undeclared || []), []);
    assert.deepEqual(errors, []);

    // Phone width.
    await page.setViewportSize({ width:390, height:844 });
    await page.waitForTimeout(200);
    assert.equal(await columnsOf(page, '.pp-list-body > .pp-row'), 1);
    await shot(page, 'firstmeasure-only-users-phone');
  } finally { await browser.close(); }
});

test('A user who may only manage users sees no group, department, subcontractor, wording, compensation or fields controls', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'users', flags:{ 'apps.payroll':false, 'platform.custom_fields':false }, setup:() => { window.Portal.util.hasPerm = (key) => key === 'manage_company_users'; } });
    assert.deepEqual(await page.locator('[data-settings-subtabs-proxy] button').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Overview', 'Users', 'Departments'], 'no groups or outside companies without project or settings access');
    await page.locator('[data-row-key="u3"] .pp-row-name').first().click();
    const dialog = page.getByRole('dialog');
    assert.deepEqual(await dialog.locator('.pp-tab').allInnerTexts().then((texts) => texts.map((text) => text.trim().replace(/\s+\d+$/, ''))), ['Permissions', 'App experience', 'Activity']);
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    await openView(page, 'home');
    assert.deepEqual(await page.locator('.pp-card strong').allInnerTexts(), ['Users', 'Departments']);
    assert.equal(await page.locator('[data-home-wording]').count(), 0, 'no Wording without company settings access');
    assert.equal(await page.locator('[data-home-attention="unlinked"], [data-home-attention="empty_groups"], [data-home-attention="pay"]').count(), 0);
    await openView(page, 'departments');
    assert.deepEqual(await page.locator('.pp-list-tools .pp-btn').allInnerTexts(), [], 'no New department without company settings access');
    assert.deepEqual(await page.evaluate(() => window.FirstMatePeople.undeclared || []), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Every People action and tab declares the capability and permission it needs', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 });
    const table = await page.evaluate(() => Object.fromEntries(Object.entries(window.FirstMatePeople.data.ACTIONS).map(([id, entry]) => [id, entry])));
    const capabilities = await page.evaluate(() => Object.keys(window.FirstMatePeople.data.CAPABILITIES));
    for (const [id, entry] of Object.entries(table)) {
      assert.ok((entry.all || []).length + (entry.any || []).length > 0, `${id} needs something`);
      assert.ok(String(entry.server || '').length > 0, `${id} names the server route or action it calls`);
      for (const key of [...(entry.all || []), ...(entry.any || [])]) assert.ok(capabilities.includes(key), `${id}: unknown capability ${key}`);
    }
    // Every needs:'...' and allows('...') in People's files (whoever wrote them) names a declared action, and every declared action is used.
    const used = new Set();
    const { readdir } = await import('node:fs/promises');
    for (const name of (await readdir(new URL('apps/people/', libraries))).filter((entry) => entry.endsWith('.js')).map((entry) => entry.slice(0, -3))) {
      const source = await readFile(new URL(`apps/people/${name}.js`, libraries), 'utf8');
      for (const match of source.matchAll(/(?:needs:\(?|allows\()(?:[^'"]*\? )?'([a-z_.]+)'(?: : '([a-z_.]+)')?/g)) { used.add(match[1]); if (match[2]) used.add(match[2]); }
    }
    used.add('compensation'); used.add('fields');   // slot tabs need their slot id
    for (const id of used) assert.ok(table[id], `${id} is used but not declared`);
    for (const id of Object.keys(table)) assert.ok(used.has(id), `${id} is declared but nothing uses it`);
    // Walking every page and a modal of each kind leaves nothing undeclared.
    for (const [view, key] of [['users', 'u3'], ['groups', 'g1'], ['departments', 'production'], ['subcontractors', 'c1']]) {
      await openView(page, view);
      await page.locator(`.pp-list-body [data-row-key="${key}"] .pp-row-name`).first().click();
      await page.getByRole('dialog').waitFor();
      await page.locator('[data-modal-close]').click();
      await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    }
    assert.deepEqual(await page.evaluate(() => window.FirstMatePeople.undeclared || []), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('A section header collapses its section: chevron, count kept, keyboard, remembered per page, opened by a search', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 });
    const section = page.locator('[data-list-section="department:sales"]');
    const toggle = section.locator('[data-section-toggle]');
    const count = await section.locator('.pp-list-section-count').innerText();
    const name = (await section.locator('.pp-row .pp-row-name').first().innerText()).trim();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await toggle.evaluate((button) => button.tagName), 'BUTTON');
    assert.ok(await section.locator('[data-list-sort]').count() > 0, 'sort buttons beside an open section');

    // Clicking the title collapses: header and count stay, rows and sort buttons go, the chevron turns.
    await toggle.click();
    await page.locator('[data-list-section="department:sales"].collapsed').waitFor();
    assert.equal(await section.locator('[data-section-toggle]').getAttribute('aria-expanded'), 'false');
    assert.equal(await section.locator('.pp-list-section-count').innerText(), count);
    assert.equal(await section.locator('.pp-list-grid').isHidden(), true);
    assert.equal(await section.locator('[data-list-sort]').count(), 0);
    assert.match(await section.locator('.pp-list-section-chevron').evaluate((icon) => getComputedStyle(icon).transform), /matrix\(0, -1, 1, 0|matrix\(6\.1|-1/);
    assert.equal(await section.locator('[data-section-toggle]').evaluate((button) => document.getElementById(button.getAttribute('aria-controls'))?.hidden), true);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.sectionToggle), 'department:sales', 'focus stays on the header');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('fm.people.list-collapse.users'))), ['department:sales']);
    await shot(page, 'users-section-collapsed');

    // Keyboard: Enter opens, Space closes.
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-list-section="department:sales"] [data-section-toggle]').getAttribute('aria-expanded') === 'true');
    assert.equal(await section.locator('.pp-list-grid').isVisible(), true);
    await page.keyboard.press('Space');
    await page.locator('[data-list-section="department:sales"].collapsed').waitFor();

    // A search opens the sections it finds rows in, without forgetting the choice.
    await page.locator('[data-list-search]').fill(name);
    await page.waitForFunction(() => !document.querySelector('[data-list-section="department:sales"].collapsed') && document.querySelector('[data-list-section="department:sales"] .pp-row'));
    await page.locator('[data-list-search]').fill('');
    await page.locator('[data-list-section="department:sales"].collapsed').waitFor();

    // Remembered: leaving the page and coming back keeps it closed; other pages keep their own.
    await openView(page, 'groups');
    assert.equal(await page.locator('.pp-list-section.collapsed').count(), 0);
    await openView(page, 'users');
    await page.locator('[data-list-section="department:sales"].collapsed').waitFor();
    await page.locator('[data-list-section="department:sales"] [data-section-toggle]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('fm.people.list-collapse.users')).length === 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('One branch: nothing about branches shows anywhere except the Branches button on the overview', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'home' });
    assert.deepEqual(await page.locator('.pp-home .pp-list-tools .pp-btn').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Branches', 'Wording']);
    for (const view of ['users', 'groups', 'departments', 'subcontractors']) {
      await openView(page, view);
      assert.equal(await page.locator('[data-branch-filter]').count(), 0, `no branch filter on ${view}`);
    }
    assert.equal(await page.locator('.pp-list-section').count(), 0, 'departments are not sectioned by branch');
    await openView(page, 'users');
    await page.locator('[data-row-key="u9"] .pp-row-name').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.locator('[data-dtree^="branch:"], [data-dtree^="region:"]').count(), 0);
    assert.doesNotMatch(await dialog.innerText(), /Main branch|Region/);
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    // The lists are read for the route's branch, as before.
    assert.equal(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'resourceGroups').branchIds), '');
    assert.deepEqual(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'connections').options), { branchId:'default' });
    assert.deepEqual(await page.evaluate(() => window.FirstMatePeople.undeclared || []), []);
    assert.deepEqual(errors, []);
    await page.close();

    // With the feature off, not even the button.
    const off = await openPage(browser, { width:1440, height:900 }, { view:'home', flags:{ 'platform.multiple_branches':false } });
    assert.deepEqual(await off.page.locator('.pp-home .pp-list-tools .pp-btn').allInnerTexts().then((texts) => texts.map((text) => text.trim())), ['Wording']);
    assert.deepEqual(off.errors, []);
  } finally { await browser.close(); }
});

test('Branches modal: name the main branch, add a region and a branch, put a branch in a region, archive; only what the viewer may do', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'home' });
    await page.locator('[data-home-branches]').click();
    const modal = page.getByRole('dialog', { name:'Branches' });
    await modal.waitFor();
    assert.equal(await modal.locator('[data-branch-row]').count(), 1);
    assert.match(await modal.locator('[data-branch-row="default"]').innerText(), /Main branch[\s\S]*My branch/);
    assert.equal(await modal.locator('[data-branch-row="default"] .pp-br-unnamed').count(), 1, 'unnamed by default');
    assert.equal(await modal.locator('[data-branch-row="default"] [data-br-action="archive"]').count(), 0, 'the main branch is never archived');
    await shot(page, 'branches-modal-one');
    // Name the main branch.
    await modal.locator('[data-branch-row="default"] [data-br-action="rename"]').click();
    await page.locator('.pp-form [name="name"]').fill('Asheville');
    await page.locator('.pp-form [type="submit"]').click();
    await modal.locator('[data-branch-row="default"]', { hasText:'Asheville' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__people.calls.filter((call) => call.action === 'organization-branches.branch.rename').pop().input), { branch_id:'default', name:'Asheville' });
    // A region, then a branch in it.
    await modal.locator('[data-br-new-region]').click();
    await page.locator('.pp-form [name="label"]').fill('East');
    await page.locator('.pp-form [type="submit"]').click();
    await modal.locator('[data-br-section="region:region_1"]').waitFor();
    await modal.locator('[data-br-new-branch]').click();
    await page.locator('.pp-form [name="name"]').fill('Boone');
    await page.locator('.pp-form [name="region_id"]').selectOption('region_1');
    await page.locator('.pp-form [type="submit"]').click();
    await modal.locator('[data-br-section="region:region_1"] [data-branch-row="boone"]').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__people.calls.filter((call) => call.action === 'organization-branches.branch.add').pop().input), { name:'Boone', region_id:'region_1' });
    // A name already taken is said plainly.
    await modal.locator('[data-br-new-branch]').click();
    await page.locator('.pp-form [name="name"]').fill('boone');
    await page.locator('.pp-form [type="submit"]').click();
    await page.locator('.pp-form .pp-form-error', { hasText:'already' }).waitFor();
    assert.equal(await page.locator('.pp-form .pp-form-error').innerText(), 'There is already a branch with that name.');
    await page.keyboard.press('Escape');
    // Put the main branch in East too.
    await modal.locator('[data-branch-row="default"] [data-br-region]').click();
    await page.getByRole('menuitemcheckbox', { name:'East' }).click();
    await modal.locator('[data-br-section="region:region_1"] [data-branch-row="default"]').waitFor();
    const regionSet = await page.evaluate(() => window.__people.calls.filter((call) => call.action === 'organization-branches.branch.region.set').pop().input);
    assert.equal(regionSet.branch_id, 'default');
    assert.equal(regionSet.region_id, 'region_1');
    assert.equal(typeof regionSet.expected_revision, 'number', 'region changes carry the catalog revision');
    await shot(page, 'branches-modal-region');
    // Archive Boone.
    await modal.locator('[data-branch-row="boone"] [data-br-action="archive"]').click();
    await page.getByRole('alertdialog').getByRole('button', { name:'Archive' }).click();
    await modal.locator('[data-br-section="archived"] [data-branch-row="boone"]').waitFor();
    assert.ok(await page.evaluate(() => window.__people.calls.every((call) => call.op !== 'invoke' || !call.action.startsWith('organization-branches.') || (call.idempotencyKey && call.target.scope === 'organization'))));
    await modal.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    assert.deepEqual(errors, []);
    await page.close();

    // A viewer who manages only their own branch: rename it, nothing else.
    const restricted = await openPage(browser, { width:390, height:844 }, { view:'home', setup:() => {
      const state = window.__people.branchState;
      state.branches.push({ id:'boone', name:'Boone', status:'active', is_default:false, region_id:'' });
      state.regions.push({ id:'east', label:'East', status:'active', branch_ids:['boone'] });
      state.access = { can_add_branch:false, can_archive_branch:false, can_manage_regions:false, can_rename_branch_ids:['default'] };
      window.Portal.util.hasPerm = (key) => key !== 'manage_all_branches';
    } });
    await restricted.page.locator('[data-home-branches]').click();
    const limited = restricted.page.getByRole('dialog', { name:'Branches' });
    await limited.waitFor();
    assert.equal(await limited.locator('[data-br-new-branch], [data-br-new-region], [data-br-region], [data-br-action="archive"], [data-region-action]').count(), 0);
    assert.equal(await limited.locator('[data-branch-row="default"] [data-br-action="rename"]').count(), 1);
    assert.equal(await limited.locator('[data-branch-row="boone"] [data-br-action]').count(), 0);
    assert.equal(await restricted.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await shot(restricted.page, 'branches-modal-restricted-phone');
    assert.deepEqual(restricted.errors, []);
  } finally { await browser.close(); }
});

test('Branch filter on Users, Groups, Departments and Subcontractors: my branch, a region, none, all, one branch, remembered per page', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { setup:multiBranch });
    const keys = () => page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('.pp-list-body [data-row-key]')).map((row) => row.dataset.rowKey))].sort());
    const expected = (kind, branches) => page.evaluate(([kind, branches]) => {
      const people = window.__people;
      const list = kind === 'users' ? people.users.map((user) => [user.id, user.branch_ids]) : kind === 'groups' ? people.groups.filter((group) => group.status === 'active').map((group) => [group.id, group.branch_ids]) : kind === 'departments' ? people.departments.map((department) => [department.id, [department.branch_id]]) : people.connections.filter((company) => company.status === 'active').map((company) => [company.id, company.branch_ids]);
      return list.filter(([, ids]) => (kind === 'subcontractors' && !ids.length) || ids.some((id) => branches.includes(id))).map(([id]) => id).sort();
    }, [kind, branches]);
    const button = page.locator('[data-branch-filter]');
    const panel = page.locator('.pp-bf');
    // The lists were read for every branch the viewer may see.
    assert.equal(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'resourceGroups').branchIds), 'all');
    assert.deepEqual(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'connections').options), { branchIds:'all' });
    for (const view of ['users', 'groups', 'departments', 'subcontractors']) {
      await openView(page, view);
      // My branch by default, named underneath.
      assert.equal(await button.locator('b').innerText(), 'My branch');
      assert.equal(await button.locator('small').innerText(), 'Asheville');
      assert.deepEqual(await keys(), await expected(view, ['asheville']), `${view}: my branch`);
      const tools = await page.locator('.pp-list-tools').boundingBox();
      const box = await button.boundingBox();
      assert.ok(box.y >= tools.y - 1 && box.y + box.height <= tools.y + tools.height + 1 && box.height <= 40, `${view}: the filter fits the header line`);
      await button.click();
      await panel.waitFor();
      assert.deepEqual(await panel.locator('[data-bf-quick]').allInnerTexts(), ['My branch', 'My region', 'All']);
      assert.deepEqual(await panel.locator('[data-bf-region] .pp-bf-pick .pp-bf-name, .pp-bf-branch .pp-bf-name').allInnerTexts(), ['East', 'Asheville', 'Boone', 'Knoxville', 'Main branch']);
      if (view === 'users') await shot(page, 'branch-filter-open');
      // A region header picks all its branches: that is My region.
      await panel.locator('[data-bf-region-pick="east"]').click();
      assert.equal(await panel.locator('[data-bf-region-pick="east"]').getAttribute('aria-checked'), 'true');
      assert.equal(await panel.locator('[data-bf-quick="region"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await button.locator('b').innerText(), 'My region');
      assert.equal(await button.locator('small').innerText(), 'East');
      assert.deepEqual(await keys(), await expected(view, ['asheville', 'boone']), `${view}: region`);
      // None.
      await panel.locator('[data-bf-none]').click();
      assert.equal(await button.locator('b').innerText(), 'No branches');
      assert.deepEqual(await keys(), view === 'subcontractors' ? await expected(view, []) : [], `${view}: none (a company in every branch still shows)`);
      // One branch, by its box: the region header is mixed when part of it is picked.
      await panel.locator('.pp-bf-branch', { has:page.locator('[data-bf-branch="boone"]') }).click();
      assert.equal(await panel.locator('[data-bf-region-pick="east"]').getAttribute('aria-checked'), 'mixed');
      assert.equal(await button.locator('b').innerText(), 'Boone');
      assert.deepEqual(await keys(), await expected(view, ['boone']), `${view}: one branch`);
      // Select all is All.
      await panel.locator('[data-bf-select-all]').click();
      assert.equal(await button.locator('b').innerText(), 'All branches');
      assert.equal(await button.locator('small').innerText(), '4 branches');
      assert.deepEqual(await keys(), await expected(view, ['default', 'asheville', 'boone', 'knox']), `${view}: all`);
      // A region folds.
      await panel.locator('[data-bf-fold="east"]').click();
      assert.equal(await panel.locator('[data-bf-fold="east"]').getAttribute('aria-expanded'), 'false');
      assert.equal(await panel.locator('[data-bf-branch="asheville"]').count(), 1);
      assert.equal(await panel.locator('.pp-bf-branch', { has:page.locator('[data-bf-branch="asheville"]') }).isVisible(), false);
      await panel.locator('[data-bf-fold="east"]').click();
      // My branch again from the quick choices, then Knoxville alone for this page.
      await panel.locator('[data-bf-quick="mine"]').click();
      assert.equal(await button.locator('b').innerText(), 'My branch');
      await panel.locator('[data-bf-none]').click();
      await panel.locator('.pp-bf-branch', { has:page.locator('[data-bf-branch="knox"]') }).click();
      await page.keyboard.press('Escape');
      await panel.waitFor({ state:'detached' });
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-branch-filter')), true, 'focus returns to the filter');
      assert.deepEqual(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), `fm.people.branch-filter.${view}`), { mode:'custom', ids:['knox'] });
    }
    // Remembered per page: each page keeps its own choice.
    await openView(page, 'groups');
    assert.equal(await button.locator('b').innerText(), 'Knoxville');
    assert.deepEqual(await keys(), await expected('groups', ['knox']));
    // Departments with several branches are sectioned by branch, under its region.
    await openView(page, 'departments');
    await button.click();
    await page.locator('[data-bf-quick="all"]').click();
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.locator('.pp-list-section-name').allInnerTexts(), ['East › Asheville', 'East › Boone', 'Knoxville', 'Main branch']);
    assert.ok(await page.locator('[data-list-section="branch:asheville"] [data-row-key="production"] .pp-stack').count() >= 1, 'rows keep their stacked counts');
    await page.locator('[data-list-section="branch:boone"] [data-section-toggle]').click();
    await shot(page, 'departments-by-branch');
    // Phone width: the filter shares the header with the search and actions.
    await page.setViewportSize({ width:390, height:844 });
    await openView(page, 'users');
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const phoneBox = await button.boundingBox();
    assert.ok(phoneBox.x >= 0 && phoneBox.x + phoneBox.width <= 390);
    await button.click();
    const panelBox = await panel.boundingBox();
    assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= 390, 'the dropdown stays on screen');
    await shot(page, 'branch-filter-phone');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => window.FirstMatePeople.undeclared || []), []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Several branches: a department is made and moved in a branch the viewer manages; the save stays strict', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'departments', setup:multiBranch });
    await page.locator('[data-list-action="0"]').click();
    assert.equal(await page.locator('.pp-form [name="branch_id"]').inputValue(), 'asheville', 'made in my branch unless I choose another');
    await page.locator('.pp-form [name="label"]').fill('Estimating');
    await page.locator('.pp-form [name="branch_id"]').selectOption('knox');
    await page.locator('.pp-form [type="submit"]').click();
    const created = page.getByRole('dialog', { name:'Estimating' });
    await created.waitFor();
    let payload = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveDepartments').pop().payload);
    assert.equal(payload.departments.find((entry) => entry.label === 'Estimating').branch_id, 'knox');
    await created.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    await page.locator('.pp-list-body [data-row-key="sales"] .pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'Sales' });
    await dialog.waitFor();
    assert.match(await dialog.locator('.pp-modal-summary').innerText(), /Asheville/);
    await dialog.locator('[data-people-identity]').click();
    await dialog.locator('select[data-identity="branch_id"]').selectOption('boone');
    await shot(page, 'department-modal-branch');
    await dialog.locator('[data-modal-save]').click();
    await page.waitForFunction(() => document.querySelector('.pp-modal-status').dataset.state === 'saved');
    payload = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'saveDepartments').pop().payload);
    assert.equal(payload.departments.find((entry) => entry.id === 'sales').branch_id, 'boone');
    assert.ok(!('groups' in payload) && !('divisions' in payload));
    assert.ok(payload.departments.every((entry) => !('group_id' in entry) && !('division_id' in entry)));
    assert.match(await dialog.locator('.pp-modal-summary').innerText(), /Boone/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Worker classification: a contractor icon beside the name, and Paid as in the Compensation tab', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 });
    const mark = (key) => page.locator(`.pp-list-body [data-row-key="${key}"] [data-name-mark="contractor"]`).first();
    // Contractors at a glance: a small icon, never a pill; employees get nothing.
    assert.equal(await mark('u7').getAttribute('data-fm-tooltip'), 'Independent contractor');
    assert.equal(await mark('u7').getAttribute('aria-label'), 'Independent contractor');
    assert.equal(await page.locator('.pp-list-body [data-row-key="u6"] [data-name-mark]').count(), 0);
    assert.equal(await page.locator('.pp-pill', { hasText:/contractor/i }).count(), 0, 'no pill');
    const iconBox = await mark('u7').boundingBox();
    assert.ok(iconBox.height <= 14, 'the icon is small');
    await page.locator('.pp-list-body [data-row-key="u7"] .pp-row-name').first().hover();
    await page.locator('.pp-hover.open [data-name-mark="contractor"]').waitFor();
    await shot(page, 'contractor-hover');
    await page.mouse.move(700, 5);

    // The user window: the icon in the summary, Paid as and payment terms at the top of Compensation.
    await page.locator('.pp-list-body [data-row-key="u7"] .pp-row-name').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.locator('.pp-sum-name [data-name-mark="contractor"]').count(), 1);
    await dialog.locator('.pp-tab', { hasText:'Compensation' }).click();
    const worker = dialog.locator('[data-worker]');
    assert.equal(await worker.locator('[data-worker-class="independent_contractor"]').getAttribute('aria-checked'), 'true');
    assert.equal(await worker.locator('[data-worker-basis]').inputValue(), 'net_days');
    assert.equal(await worker.locator('[data-worker-days]').inputValue(), '30');
    await worker.locator('[data-worker-days]').fill('15');
    await worker.locator('[data-worker-days]').dispatchEvent('change');
    await page.waitForFunction(() => window.__people.calls.some((call) => call.action === 'payroll.contractor.worker.update'));
    const call = await page.evaluate(() => window.__people.calls.filter((entry) => entry.action === 'payroll.contractor.worker.update').pop());
    assert.deepEqual(call.input, { worker_classification:'independent_contractor', payment_terms:{ basis:'net_days', net_days:15 } });
    assert.equal(call.target.id, 'u7');
    assert.ok(call.idempotencyKey);
    await shot(page, 'user-modal-paid-as-contractor');
    // Paid as an employee: no terms, and the icon goes.
    await worker.locator('[data-worker-class="employee"]').click();
    await worker.locator('[data-worker-class="employee"][aria-checked="true"]').waitFor();
    assert.equal(await worker.locator('[data-worker-basis]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__people.calls.filter((entry) => entry.action === 'payroll.contractor.worker.update').pop().input), { worker_classification:'employee', payment_terms:{ basis:'net_days', net_days:15 } });
    assert.equal(await dialog.locator('.pp-sum-name [data-name-mark]').count(), 0);
    await shot(page, 'user-modal-paid-as-employee');
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    assert.equal(await page.locator('.pp-list-body [data-row-key="u7"] [data-name-mark]').count(), 0);
    // Back to contractor from the list's own person: the icon appears on the row.
    await page.locator('.pp-list-body [data-row-key="u6"] .pp-row-name').first().click();
    await dialog.locator('.pp-tab', { hasText:'Compensation' }).click();
    await dialog.locator('[data-worker-class="independent_contractor"]').click();
    await dialog.locator('[data-worker-basis]').waitFor();
    assert.equal(await dialog.locator('[data-worker-basis]').inputValue(), 'payroll_schedule');
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    await mark('u6').waitFor();
    await shot(page, 'users-contractor-icon');
    assert.deepEqual(await page.evaluate(() => window.FirstMatePeople.undeclared || []), []);
    assert.deepEqual(errors, []);
    await page.close();

    // Payroll without user or settings access sees how people are paid but cannot change it (the action needs either).
    const payroll = await openPage(browser, { width:1440, height:900 }, { setup:() => { window.Portal.util.hasPerm = (key) => ['manage_payroll', 'manage_company_user_permissions'].includes(key); } });
    assert.equal(await payroll.page.locator('.pp-list-body [data-row-key="u7"] [data-name-mark="contractor"]').count() > 0, true);
    await payroll.page.locator('.pp-list-body [data-row-key="u7"] .pp-row-name').first().click();
    await payroll.page.getByRole('dialog').locator('.pp-tab', { hasText:'Compensation' }).click();
    assert.equal(await payroll.page.locator('[data-worker-class="employee"]').isDisabled(), true);
    assert.equal(await payroll.page.locator('[data-worker-basis]').isDisabled(), true);
    assert.deepEqual(payroll.errors, []);
    await payroll.page.close();

    // Without payroll: no icon and no Compensation tab.
    const noPayroll = await openPage(browser, { width:1440, height:900 }, { flags:{ 'apps.payroll':false } });
    assert.equal(await noPayroll.page.locator('[data-name-mark]').count(), 0);
    await noPayroll.page.locator('.pp-list-body [data-row-key="u7"] .pp-row-name').first().click();
    assert.equal(await noPayroll.page.getByRole('dialog').locator('.pp-tab', { hasText:'Compensation' }).count(), 0);
    assert.deepEqual(noPayroll.errors, []);
  } finally { await browser.close(); }
});

test('Archive a person (kept, cannot sign in, restorable) and restore them from Archived', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 });
    await page.locator('.pp-list-body [data-row-key="u21"]').first().hover();
    await page.locator('.pp-list-body [data-row-key="u21"] [data-row-action="archive"]').first().click();
    const form = page.locator('.pp-form');
    assert.match(await form.locator('.pp-form-note').innerText(), /kept for the record[\s\S]*can no longer sign in[\s\S]*restored/);
    await form.locator('[name="reason"]').fill('Left the company');
    await shot(page, 'user-archive-form');
    await form.locator('[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-list-body [data-row-key="u21"]'));
    assert.deepEqual(await page.evaluate(() => window.__people.calls.find((call) => call.op === 'remove')), { op:'remove', id:'u21', reason:'Left the company' });
    await page.locator('[data-list-filter="archived"]').click();
    const row = page.locator('.pp-list-body [data-row-key="u21"]');
    await row.waitFor();
    assert.match(await row.locator('.pp-pill').getAttribute('data-fm-tooltip'), /Left the company/);
    await shot(page, 'users-archived-restore');
    await row.hover();
    await row.locator('[data-row-action="restore"]').click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.action === 'workforce.users.restore'));
    const call = await page.evaluate(() => window.__people.calls.find((entry) => entry.action === 'workforce.users.restore'));
    assert.equal(call.target.id, 'u21');
    assert.ok(call.idempotencyKey);
    await page.locator('.pp-list-body [data-row-key="u21"]').waitFor({ state:'detached' });
    await page.locator('[data-list-filter="all"]').click();
    await page.locator('.pp-list-body [data-row-key="u21"]').first().waitFor();
    assert.deepEqual(errors, []);
    await page.close();
    // A FirstMeasure-only organization archives too, but restoring needs the workforce actions, so it is not offered.
    const legacy = await openPage(browser, { width:1440, height:900 }, { view:'direct', flags:{ 'platform.people_access':false, 'platform.expanded_access':false }, setup:() => { window.__people.users.find((user) => user.id === 'u30').deleted = true; } });
    await legacy.page.locator('[data-list-filter="archived"]').click();
    await legacy.page.locator('.pp-list-body [data-row-key="u30"]').waitFor();
    assert.equal(await legacy.page.locator('.pp-list-body [data-row-action="restore"]').count(), 0);
    assert.deepEqual(legacy.errors, []);
  } finally { await browser.close(); }
});

test('Branches of a person, a group and an outside company: changed in each window and for everyone a list shows', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { setup:[multiBranch, () => { window.__people.branchState.access = { manageable_branch_ids:['default', 'asheville', 'boone'] }; }] });
    const calls = () => page.evaluate(() => window.__people.calls.filter((call) => call.action === 'organization-branches.membership.set').map((call) => call.input));
    // A person: one of Asheville's.
    await page.locator('.pp-list-body [data-row-key="u5"] .pp-row-name').first().click();
    let dialog = page.getByRole('dialog');
    const section = dialog.locator('[data-section="branches"]');
    assert.deepEqual(await section.locator('.pp-chip').allInnerTexts(), ['Asheville']);
    await section.locator('[data-people-section-action="branches"]').click();
    const menu = page.getByRole('menu', { name:'Branches' });
    await menu.waitFor();
    assert.equal(await menu.getByRole('menuitemcheckbox', { name:'Knoxville' }).isDisabled(), true, 'a branch outside the viewer\'s reach cannot be picked');
    await shot(page, 'user-branches-menu');
    await menu.getByRole('menuitemcheckbox', { name:'Boone' }).click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.action === 'organization-branches.membership.set'));
    assert.deepEqual((await calls()).pop(), { assignee:{ type:'organization_user', id:'u5' }, branch_ids:['asheville', 'boone'], primary_branch_id:'asheville' });
    await page.keyboard.press('Escape');
    await section.locator('.pp-chip', { hasText:'Boone' }).waitFor();
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    // A group and an outside company.
    await openView(page, 'groups');
    await page.locator('.pp-list-body [data-row-key="g1"] .pp-row-name').click();
    dialog = page.getByRole('dialog');
    await dialog.locator('[data-section="branches"] [data-people-section-action="branches"]').click();
    await page.getByRole('menuitemcheckbox', { name:'Main branch' }).click();
    await page.waitForFunction(() => window.__people.calls.filter((call) => call.action === 'organization-branches.membership.set').length === 2);
    assert.deepEqual((await calls()).pop(), { assignee:{ type:'resource_group', id:'g1' }, branch_ids:['asheville', 'default'], primary_branch_id:'asheville' });
    await page.keyboard.press('Escape');
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    await openView(page, 'subcontractors');
    await page.locator('.pp-list-body [data-row-key="c1"] .pp-row-name').click();
    dialog = page.getByRole('dialog');
    assert.deepEqual(await dialog.locator('[data-section="branches"] .pp-chip').allInnerTexts(), ['Every branch'], 'a company in no branch works in every branch');
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    // Everyone a list shows: the filter's dropdown offers it.
    await openView(page, 'users');
    const shown = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('.pp-list-body [data-row-key]')).map((row) => row.dataset.rowKey))].length);
    await page.locator('[data-branch-filter]').click();
    await page.locator('[data-bf-bulk]').click();
    const form = page.locator('.pp-form');
    assert.match(await form.locator('.pp-form-title').innerText(), new RegExp(`${shown} users shown`));
    await form.locator('[name="mode"]').selectOption('add');
    await form.locator('[name="branch"]').selectOption('boone');
    await shot(page, 'users-branches-bulk');
    const before = (await calls()).length;
    await form.locator('[type="submit"]').click();
    await page.waitForFunction((count) => !document.querySelector('.pp-form') && window.__people.calls.filter((call) => call.action === 'organization-branches.membership.set').length > count, before);
    const bulk = (await calls()).slice(before);
    assert.ok(bulk.length >= shown - 1, 'one change per person shown (those already in Boone are skipped)');
    assert.ok(bulk.every((input) => input.branch_ids.includes('boone') && input.assignee.type === 'organization_user'));
    assert.deepEqual(errors, []);
    await page.close();
    // One branch: no Branches section anywhere.
    const single = await openPage(browser, { width:1440, height:900 });
    await single.page.locator('.pp-list-body [data-row-key="u5"] .pp-row-name').first().click();
    await single.page.getByRole('dialog').waitFor();
    assert.equal(await single.page.locator('[data-section="branches"]').count(), 0);
    assert.deepEqual(single.errors, []);
  } finally { await browser.close(); }
});

test('Branch and region words are the organization\'s: Wording sets them, and People uses them everywhere', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'home', setup:multiBranch });
    await page.locator('[data-home-wording]').click();
    const panel = page.locator('.pp-wording');
    await panel.locator('[name="branch_singular"]').fill('Yard');
    await panel.locator('[name="branch_plural"]').fill('Yards');
    await panel.locator('[name="region_singular"]').fill('District');
    await panel.locator('[name="region_plural"]').fill('Districts');
    await shot(page, 'wording-branches');
    await panel.locator('[type="submit"]').click();
    await panel.waitFor({ state:'detached' });
    const patch = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'modulePatch').pop());
    assert.equal(patch.branchId, 'default', 'kept with the default branch: the words are the organization\'s');
    assert.equal(patch.moduleId, 'variable_mappings');
    assert.deepEqual(patch.data.labels.branches, { branch:'Yard', branches:'Yards', region:'District', regions:'Districts' });
    assert.equal(await page.locator('[data-home-branches] .pp-btn-label').innerText(), 'Yards');
    await openView(page, 'users');
    const button = page.locator('[data-branch-filter]');
    assert.equal(await button.locator('b').innerText(), 'My yard');
    await button.click();
    assert.deepEqual(await page.locator('[data-bf-quick]').allInnerTexts(), ['My yard', 'My district', 'All']);
    assert.ok(await page.locator('.pp-bf-name', { hasText:'Main yard' }).count(), 'the unnamed default branch takes the organization\'s word');
    await shot(page, 'branch-filter-own-words');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Outside company onboarding: requirements on the company type, a checklist with documents and expiry dates, and a warning in the list', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'subcontractors' });
    // The company type says what is needed.
    await page.locator('.pp-list-tools .pp-btn', { hasText:'Types' }).click();
    const typesDialog = page.getByRole('dialog').last();
    await typesDialog.locator('[data-type-id="roofing_sub"] .pp-type-open').click();
    const typeDialog = page.getByRole('dialog', { name:'Roofing' });
    await typeDialog.locator('.pp-tab', { hasText:'Onboarding' }).click();
    await typeDialog.locator('[data-onb-usual]').click();
    await typeDialog.locator('.pp-type', { hasText:'Certificate of insurance' }).waitFor();
    const saved = await page.evaluate(() => window.__people.calls.filter((call) => call.action === 'assignees.type.save').pop().input);
    assert.deepEqual(saved.onboarding_requirements.map((entry) => [entry.id, entry.kind, entry.expires, entry.required]), [['w9', 'document', false, true], ['insurance', 'document', true, true], ['license', 'document', true, true], ['agreement', 'document', false, true]]);
    await typeDialog.locator('[data-onb-edit="agreement"]').click();
    await page.locator('.pp-form [name="kind"]').selectOption('check');
    await page.locator('.pp-form [name="required"]').selectOption('no');
    await page.locator('.pp-form [type="submit"]').click();
    await typeDialog.locator('.pp-type[data-type-id="agreement"]', { hasText:'Optional' }).waitFor();
    await shot(page, 'company-type-onboarding');
    await typeDialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    // The list warns about a company that has not provided them.
    const mark = page.locator('.pp-list-body [data-row-key="c1"] [data-name-mark="onboarding-incomplete"]');
    await mark.waitFor();
    assert.match(await mark.getAttribute('data-fm-tooltip'), /Onboarding incomplete: W-9, Certificate of insurance, License/);
    // The company's window: upload, date and check.
    await page.locator('.pp-list-body [data-row-key="c1"] .pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'Summit Roofing' });
    await dialog.locator('.pp-tab', { hasText:'Onboarding' }).click();
    assert.deepEqual(await dialog.locator('.pp-onb-item').evaluateAll((items) => items.map((item) => `${item.dataset.onbItem}:${item.dataset.status}`)), ['w9:missing', 'insurance:missing', 'license:missing', 'agreement:optional']);
    const upload = async (id, name) => {
      const chooser = page.waitForEvent('filechooser');
      await dialog.locator(`[data-onb-upload="${id}"]`).click();
      await (await chooser).setFiles({ name, mimeType:'application/pdf', buffer:Buffer.from('%PDF-1.4') });
      await dialog.locator('.pp-onb-doc', { hasText:name }).waitFor();
    };
    await upload('w9', 'w9-2026.pdf');
    await upload('insurance', 'coi.pdf');
    const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    await dialog.locator('.pp-onb-item[data-onb-item="insurance"] [data-onb-doc-expiry]').fill(soon);
    await dialog.locator('.pp-onb-item[data-onb-item="insurance"] [data-onb-doc-expiry]').dispatchEvent('change');
    await dialog.locator('.pp-onb-item[data-onb-item="insurance"][data-status="expiring"]').waitFor();
    await upload('license', 'license.pdf');
    await dialog.locator('.pp-onb-item[data-onb-item="license"] [data-onb-doc-expiry]').fill('2020-01-01');
    await dialog.locator('.pp-onb-item[data-onb-item="license"] [data-onb-doc-expiry]').dispatchEvent('change');
    await dialog.locator('.pp-onb-item[data-onb-item="license"][data-status="expired"]').waitFor();
    await dialog.locator('[data-onb-check="agreement"]').click();
    await dialog.locator('.pp-onb-item[data-onb-item="agreement"][data-status="done"]').waitFor();
    const uploads = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'mediaUpload').map((call) => call.owner));
    assert.ok(uploads.every((owner) => owner.type === 'company' && owner.id === 'c1'), 'documents are media owned by the company');
    const record = await page.evaluate(() => window.__people.connections.find((entry) => entry.id === 'c1').metadata.onboarding);
    assert.deepEqual(record.items, { agreement:{ done:true } });
    assert.deepEqual(record.documents.map((entry) => [entry.requirement_id, entry.title, entry.expires_at || '']), [['w9', 'w9-2026.pdf', ''], ['insurance', 'coi.pdf', soon], ['license', 'license.pdf', '2020-01-01']]);
    await shot(page, 'company-onboarding');
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    assert.match(await mark.getAttribute('data-fm-tooltip'), /Onboarding incomplete: License/, 'an expired required item');
    await shot(page, 'subcontractors-onboarding-warning');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Invite an outside company to link its own organization: invite, resend, withdraw; hidden without collaboration', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, { view:'subcontractors' });
    await page.locator('.pp-list-body [data-row-key="c3"] .pp-row-name').click();
    const dialog = page.getByRole('dialog', { name:'Volt Brothers' });
    await dialog.locator('.pp-tab', { hasText:'Link' }).click();
    const invite = dialog.locator('[data-company-invite]');
    assert.equal(await invite.locator('[data-invite-state]').getAttribute('data-invite-state'), 'none');
    await invite.locator('[data-invite-send]').click();
    await page.locator('.pp-form [name="email"]').fill('office@voltbrothers.example');
    await page.locator('.pp-form [type="submit"]').click();
    await dialog.locator('[data-invite-state="pending"]').waitFor();
    const requests = await page.evaluate(() => window.__people.calls.filter((call) => call.op === 'collaboration').map((call) => [call.method, call.path, call.body]));
    assert.deepEqual(requests[0], ['POST', '/partner-invitations', { name:'Volt Brothers', email:'office@voltbrothers.example', workforce_connection_id:'c3' }]);
    assert.deepEqual(requests[1].slice(0, 2), ['POST', '/invitations/invitation_1/send']);
    assert.match(await dialog.locator('[data-company-invite]').innerText(), /Invited, waiting for them[\s\S]*office@voltbrothers.example/);
    await shot(page, 'company-invite-pending');
    await dialog.locator('[data-invite-resend]').click();
    await page.waitForFunction(() => window.__people.calls.filter((call) => call.op === 'collaboration' && call.path.endsWith('/send')).length === 2);
    await dialog.locator('[data-invite-revoke]').click();
    await page.getByRole('alertdialog').getByRole('button', { name:'Withdraw' }).click();
    await dialog.locator('[data-invite-state="revoked"]').waitFor();
    assert.ok(await page.evaluate(() => window.__people.calls.some((call) => call.op === 'collaboration' && call.path === '/invitations/invitation_1/revoke' && call.body.expected_revision === 1)));
    await dialog.locator('[data-modal-close]').click();
    await page.waitForFunction(() => !document.querySelector('.pp-modal-back'));
    // A linked company shows its link and nothing to send.
    await page.locator('.pp-list-body [data-row-key="c1"] .pp-row-name').click();
    await page.getByRole('dialog').locator('.pp-tab', { hasText:'Link' }).click();
    await page.locator('[data-invite-state="linked"]').waitFor();
    assert.equal(await page.locator('[data-invite-send], [data-invite-resend]').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
    const off = await openPage(browser, { width:1440, height:900 }, { view:'subcontractors', flags:{ 'platform.collaboration':false } });
    await off.page.locator('.pp-list-body [data-row-key="c3"] .pp-row-name').click();
    await off.page.getByRole('dialog').locator('.pp-tab', { hasText:'Link' }).click();
    assert.equal(await off.page.locator('[data-company-invite]').count(), 0, 'no invitation without collaboration');
    assert.deepEqual(off.errors, []);
  } finally { await browser.close(); }
});

// 1M8-235: a super admin can suspend, archive or revoke anyone except the account owner, themselves and the last active
// super admin; a disabled action says why.
test('suspend and archive stay open for other super admins; the owner, yourself and the last super admin are protected', async () => {
  const browser = await launch();
  const actions = (page, key) => page.locator(`[data-row-key="${key}"] .pp-row-actions button`).evaluateAll((buttons) => buttons.map((button) => [button.getAttribute('aria-label'), button.disabled]));
  try {
    const invitedAdmin = { ...FIRSTMEASURE_ONLY, setup:[FIRSTMEASURE_ONLY.setup, () => {
      const users = window.__people.users;
      // u5 was invited as a super admin and has not signed in; u3 created the account at signup.
      Object.assign(users.find((user) => user.id === 'u5'), { role:'super_admin', org_permissions:{ level:'super_admin', items:{} } });
      Object.assign(users.find((user) => user.id === 'u3'), { role:'owner', org_permissions:{}, permissions:{ '*':true } });
    }] };
    const { page, errors } = await openPage(browser, { width:1440, height:900 }, invitedAdmin);
    for (const key of ['u1', 'u3', 'u5']) await page.locator(`[data-row-key="${key}"]`).hover();
    assert.deepEqual(await actions(page, 'u5'), [['Edit', false], ['Resend invitation', false], ['Suspend', false], ['Revoke invitation', false]], 'an invited super admin can be revoked');
    assert.deepEqual(await actions(page, 'u3'), [['Edit', false], ['The account owner cannot be suspended or archived', true], ['The account owner cannot be suspended or archived', true]]);
    assert.deepEqual((await actions(page, 'u1')).slice(-2), [['You cannot suspend or archive yourself', true], ['You cannot suspend or archive yourself', true]]);
    // Revoking the invitation archives u5 after the confirmation.
    await page.locator('[data-row-key="u5"] [data-row-action="archive"]').click();
    await page.locator('.pp-form .pp-btn.primary').filter({ hasText:'Revoke invitation' }).click();
    await page.waitForFunction(() => window.__people.calls.some((call) => call.op === 'remove' && call.id === 'u5') || window.__people.toasts.some((toast) => /Invitation revoked/.test(JSON.stringify(toast))));
    assert.deepEqual(errors, []);

    // Signed in as someone else, the only active super admin cannot be suspended or archived.
    const lastAdmin = { ...FIRSTMEASURE_ONLY, setup:[FIRSTMEASURE_ONLY.setup, () => { Object.assign(window.__APP, { userId:'u2', userEmail:window.__people.users[1].email }); }] };
    const other = await openPage(browser, { width:1440, height:900 }, lastAdmin);
    await other.page.locator('[data-row-key="u1"]').hover();
    assert.deepEqual((await actions(other.page, 'u1')).slice(-2), [['Make someone else a super admin first: an account needs at least one', true], ['Make someone else a super admin first: an account needs at least one', true]]);
    assert.deepEqual(other.errors, []);
  } finally { await browser.close(); }
});
