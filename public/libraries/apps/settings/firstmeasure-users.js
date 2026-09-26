/* FirstMeasure Users variant, extracted from FirstMeasure 686d3fe.
 * Keep this UI independent of the platform People & Access component.
 * Shared PlatformAPI user endpoints remain the authority for permissions.
 */
(function(){
  window.FirstMeasureUsers = { mount(paneUsers, dependencies) {
    const { $, escapeHtml, injectCSS, postAction, hasPerm } = window.Portal.util;
    const { showToast } = window.Portal.ui;
    const { portalAssetUrl, platformUserFromDocument, uploadUserAvatar } = dependencies;
    const currentOrgId = () => String(window.__APP?.userOrgId || '');
    const ME_EMAIL = String(window.__APP?.userEmail || '').toLowerCase().trim();
    const canUsers = hasPerm('manage_company_users') || hasPerm('manage_company_user_permissions');
    const usersState = { list:[], itemsById:{}, showPerms:true, superAdmins:[], openMenuUserId:null };
    let usersRefreshSeq=0, floatingMenu=null;
    const lifecycle = new AbortController();
    const openModals = new Set();
  const PERM_META = [
    { k:'order_reports',                   label:(globalThis.PlatformLanguage?.text("settings","m_a0d673c98d109b","Order Reports") ?? "Order Reports") },
    { k:'view_reports',                    label:(globalThis.PlatformLanguage?.text("settings","m_0cb4deb6e0a11b","View Reports") ?? "View Reports") },
    { k:'manage_billing',                  label:(globalThis.PlatformLanguage?.text("settings","m_707e3bb60aa697","Manage Billing") ?? "Manage Billing") },
    { k:'manage_company_settings',         label:(globalThis.PlatformLanguage?.text("settings","m_3ca553a96e2d57","Manage Company Settings") ?? "Manage Company Settings") },
    { k:'manage_report_settings',          label:(globalThis.PlatformLanguage?.text("settings","m_92a0f4a34883f8","Manage Report Settings") ?? "Manage Report Settings") },
    { k:'manage_company_users',            label:(globalThis.PlatformLanguage?.text("settings","m_3e5cbdf732a7e4","Manage Users") ?? "Manage Users") },
    { k:'manage_company_user_permissions', label:(globalThis.PlatformLanguage?.text("settings","m_4100a91e5391b6","Manage User Permissions") ?? "Manage User Permissions") },
  ];
  const LEVEL_OPTIONS = [
    { v:'viewer',      label:(globalThis.PlatformLanguage?.text("settings","m_ee8002871331aa","Viewer") ?? "Viewer") },
    { v:'manager',     label:(globalThis.PlatformLanguage?.text("settings","m_32263fb2e2d35f","Manager") ?? "Manager") },
    { v:'admin',       label:(globalThis.PlatformLanguage?.text("settings","m_624b3522fe2950","Admin") ?? "Admin") },
    { v:'custom',      label:(globalThis.PlatformLanguage?.text("settings","m_6edcf7d7d41112","Custom") ?? "Custom") },
    { v:'super_admin', label:(globalThis.PlatformLanguage?.text("settings","m_1a6b2c0ae6f76c","Super Admin") ?? "Super Admin") },
  ];
  const LEVEL_PRESET_META = [
    { v:'viewer',      label:(globalThis.PlatformLanguage?.text("settings","m_ee8002871331aa","Viewer") ?? "Viewer"),      icon:'fa-eye' },
    { v:'manager',     label:(globalThis.PlatformLanguage?.text("settings","m_32263fb2e2d35f","Manager") ?? "Manager"),     icon:'fa-briefcase' },
    { v:'admin',       label:(globalThis.PlatformLanguage?.text("settings","m_624b3522fe2950","Admin") ?? "Admin"),       icon:'fa-shield-halved' },
    { v:'super_admin', label:(globalThis.PlatformLanguage?.text("settings","m_1a6b2c0ae6f76c","Super Admin") ?? "Super Admin"), icon:'fa-user-shield' },
  ];
  const LEVEL_PERM_DEFAULTS = {
    viewer: {
      order_reports:false,
      view_reports:true,
      manage_billing:false,
      manage_company_settings:false,
      manage_report_settings:false,
      manage_company_users:false,
      manage_company_user_permissions:false,
    },
    manager: {
      order_reports:true,
      view_reports:true,
      manage_billing:false,
      manage_company_settings:false,
      manage_report_settings:false,
      manage_company_users:false,
      manage_company_user_permissions:false,
    },
    admin: {
      order_reports:true,
      view_reports:true,
      manage_billing:true,
      manage_company_settings:true,
      manage_report_settings:true,
      manage_company_users:true,
      manage_company_user_permissions:false,
    },
    super_admin: Object.fromEntries(PERM_META.map(pm => [pm.k, true])),
  };
  function normLevel(u){
    const lvl = (u && u.org_permissions && u.org_permissions.level) ? u.org_permissions.level : 'viewer';
    return String(lvl || 'viewer').toLowerCase().trim();
  }
  function normEmail(u){
    return String(u?.email || '').toLowerCase().trim();
  }
  function asBoolMap(m){
    const out = {};
    if (m && typeof m === 'object'){
      for (const k of Object.keys(m)) out[k] = !!m[k];
    }
    return out;
  }
  function effectivePerms(u){
    const eff = (u && u.effective_permissions && typeof u.effective_permissions === 'object') ? u.effective_permissions : {};
    return asBoolMap(eff);
  }
  function levelLabel(lvl){
    const x = String(lvl || '').toLowerCase().trim();
    const hit = LEVEL_OPTIONS.find(o => o.v === x);
    return hit ? hit.label : (x ? x : 'Viewer');
  }
  function clonedLevelPerms(level){
    const key = String(level || '').toLowerCase().trim();
    const src = LEVEL_PERM_DEFAULTS[key];
    if (!src || typeof src !== 'object') return {};
    return Object.assign({}, src);
  }
  function effectiveOrLocalPermsForUser(u, userId){
    const lvl = normLevel(u) || 'viewer';
    if (lvl === 'custom') {
      return Object.assign({}, usersState.itemsById[userId] || asBoolMap(u?.org_permissions?.items || {}));
    }
    const preset = clonedLevelPerms(lvl);
    if (Object.keys(preset).length) return preset;
    return asBoolMap(effectivePerms(u));
  }
  function effectivePermsForLevel(level, items){
    const lvl = String(level || 'viewer').toLowerCase().trim();
    if (lvl === 'custom') return Object.assign({}, asBoolMap(items || {}));
    const preset = clonedLevelPerms(lvl);
    if (Object.keys(preset).length) return preset;
    return Object.assign({}, asBoolMap(items || {}));
  }
  function permissionHintText(level, canEdit){
    return canEdit ? '' : 'Permissions are read-only.';
  }
  function userInitial(name, email){
    const raw = String(name || email || '?').trim();
    return raw ? raw.charAt(0).toUpperCase() : '?';
  }
  function userAvatarUrl(u){
    return portalAssetUrl(u?.profile_photo_url || u?.profile_photo || '');
  }
  function renderRolePresetButtons(activeLevel, disabled){
    const isDisabled = !!disabled;
    return LEVEL_PRESET_META.map(meta => {
      const active = String(activeLevel || '').toLowerCase().trim() === meta.v ? 'active' : '';
      return `<button class="fmu-roleBtn ${active}" data-role="${escapeHtml(meta.v)}" type="button" ${isDisabled ? 'disabled' : ''}><i class="fas ${meta.icon}"></i> ${escapeHtml(meta.label)}</button>`;
    }).join('') + `<button class="fmu-roleBtn custom ${String(String(activeLevel || '').toLowerCase().trim() === 'custom' ? 'active' : '')}" data-role="custom" type="button" ${String(isDisabled ? 'disabled' : '')}><i class="fas fa-sliders"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_b8a62e4ea304dc"," Custom") ?? " Custom")}</button>`;
  }
  function renderPermissionButtons(items, disabled){
    const isDisabled = !!disabled;
    return PERM_META.map(pm => {
      const on = !!items[pm.k];
      return `<button class="fmu-pbtn ${on ? 'on' : 'off'} ${isDisabled ? 'ro' : ''}" data-perm="${escapeHtml(pm.k)}" type="button" ${isDisabled ? 'disabled' : ''}><span class="dot"></span><span>${escapeHtml(pm.label)}</span></button>`;
    }).join('');
  }
  // **** Users API ----
  async function usersList(){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.list) {
      const result = await window.PlatformAPI.users.list(orgId);
      return { ok:true, users: result.users || [] };
    }
    const { data } = await postAction('org_users_list_my');
    if (!data || !data.success) return { ok:false, error: data?.error || 'List failed' };
    return { ok:true, users: data.users || [] };
  }
  async function userAdd({ email, name, permLevel, permItems }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.create) {
      const result = await window.PlatformAPI.users.create(orgId, {
        email: email || '',
        name: name || '',
        role: permLevel || 'viewer',
        status: 'invited',
        permissions: permItems || {},
        account_type: 'customer'
      });
      return {
        ok:true,
        user: platformUserFromDocument(result.document || {}),
        emailed: !!(result.emailed || result.email_sent),
        activate_url: result.activate_url || result.invite?.activate_url || null,
        error: result.invite?.error || ''
      };
    }
    const { data } = await postAction('org_users_add_my', {
      email: email || '',
      name: name || '',
      perm_level: permLevel || 'viewer',
      perm_items_json: JSON.stringify(permItems || {})
    });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Add failed' };
    return { ok:true, user: data.user || null, emailed: !!data.emailed, activate_url: data.activate_url || null };
  }
  async function userSetDisabled({ userId, disabled }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.setDisabled) {
      const result = await window.PlatformAPI.users.setDisabled(orgId, userId || '', !!disabled);
      return { ok:true, user: platformUserFromDocument(result.document || {}) };
    }
    const { data } = await postAction('org_users_set_disabled_my', {
      user_id: userId || '',
      disabled: disabled ? 'true' : 'false'
    });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Update failed' };
    return { ok:true, user: data.user || null };
  }
  async function userResendInvite({ userId }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.resendInvite) {
      const result = await window.PlatformAPI.users.resendInvite(orgId, userId || '');
      return {
        ok: !!(result.ok || result.success || result.emailed || result.email_sent),
        emailed: !!(result.emailed || result.email_sent || result.ok),
        activate_url: result.activate_url || '',
        error: result.error || result.message || ''
      };
    }
    return { ok:false, error:'Invite resend is unavailable.' };
  }
  async function userUpdate({ userId, email, name }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.patch) {
      const result = await window.PlatformAPI.users.patch(orgId, userId || '', {
        email: String(email || '').trim().toLowerCase(),
        name: name || ''
      }, { source: 'org_users_update' });
      return { ok:true, user: platformUserFromDocument(result.document || {}), sessionUpdated:false };
    }
    const { data } = await postAction('org_users_update_my', {
      user_id: userId || '',
      email: email || '',
      name: name || ''
    });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Update failed' };
    return { ok:true, user: data.user || null, sessionUpdated: !!data.session_updated };
  }
  async function userSoftDelete({ userId }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.remove) {
      await window.PlatformAPI.users.remove(orgId, userId || '');
      return { ok:true };
    }
    const { data } = await postAction('org_users_delete_my', { user_id: userId || '' });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Delete failed' };
    return { ok:true };
  }
  async function userSetPerms({ userId, permLevel, permItems }){
    const orgId = currentOrgId();
    if (orgId && window.PlatformAPI?.users?.setPermissions) {
      const result = await window.PlatformAPI.users.setPermissions(orgId, userId || '', permLevel || 'viewer', permItems || {});
      return { ok:true, user: platformUserFromDocument(result.document || {}) };
    }
    const { data } = await postAction('org_users_set_perms_my', {
      user_id: userId || '',
      perm_level: permLevel || 'viewer',
      perm_items_json: JSON.stringify(permItems || {})
    });
    if (!data || !data.success) return { ok:false, error: data?.error || 'Update failed' };
    return { ok:true, user: data.user || null };
  }
    injectCSS('firstmeasure_users', `.li-editor .fmu-shared-in{width:100%;max-width:100%;min-width:0;box-sizing:border-box}
.li-editor .fmu-shared-in{font-size:12px;padding:8px 10px;border-radius:10px;font-weight:500}
.li-pricing-row .fmu-shared-in,.li-option-row .fmu-shared-in{padding:8px 9px;border-radius:9px;font-size:12px}
.fmu-shared-btn.icon{width:34px;height:34px;padding:0;border-radius:10px;align-items:center;justify-content:center;background:#fff;border:1px solid #d0d5dd;color:#475467;box-shadow:none}
@media(max-width:1180px){.crew-member-row .fmu-shared-btn.icon{align-self:end}
}
@media(max-width:760px){.crew-member-row .fmu-shared-btn.icon{width:100%}
.crew-card-actions .fmu-shared-btn{justify-content:center;flex:1}
}
.fmu-shared-in{ border: 1px solid rgba(0,0,0,0.14); border-radius: 14px; padding: 12px 12px; font-weight: 850; font-size: 14px; outline:none; box-sizing:border-box; max-width:100%; }
.fmu-shared-in:focus{ border-var(--primary-readable, var(--primary,#d93025)); box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),0.12); }
.fmu-shared-btn{ border:none; border-radius:999px; padding:12px 14px; font-weight:1000; cursor:pointer; display:inline-flex; align-items:center; gap:8px; transition:.16s ease; }
.fmu-shared-btn.primary{ background:var(--primary,#d93025); color:var(--on-primary, #fff); box-shadow:0 12px 26px rgba(var(--primary-rgb,217,48,37),0.22); }
.fmu-shared-btn.ghost{ background:#fff; border:1px solid rgba(0,0,0,0.14); color:#333; }
.fmu-shared-btn.ghost:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
.fmu-shared-btn.danger{ background:#111; color:#fff; }
.fmu-shared-note{ font-size:12px; font-weight:800; color:#777; line-height:1.4; margin-top:8px; }
.fmu-top{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:12px; flex-wrap:wrap; }
.fmu-title{ font-weight:1000; font-size:16px; }
.fmu-actions{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.fmu-btn{
        border:1px solid rgba(0,0,0,0.14);
        background:#fff;
        border-radius:999px;
        padding:10px 12px;
        font-weight:1000;
        cursor:pointer;
        transition:.14s ease;
        display:inline-flex; align-items:center; gap:8px;
        user-select:none;
      }
.fmu-btn:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
.fmu-btn.toggle.on{
        border-color: rgba(var(--primary-rgb,217,48,37),0.45);
        var(--primary-readable, var(--primary,#d93025));
        box-shadow:0 12px 26px rgba(var(--primary-rgb,217,48,37),0.12);
      }
.fmu-table{ width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; border-radius:16px; border:1px solid rgba(0,0,0,0.10); }
.fmu-th,.fmu-td{ padding:12px 12px; font-size:13px; vertical-align:top; }
.fmu-th{ background:rgba(0,0,0,0.02); font-weight:1000; color:#444; border-bottom:1px solid rgba(0,0,0,0.08); }
.fmu-trMain .fmu-td{ border-top:1px solid rgba(0,0,0,0.06); }
.fmu-trMain:first-child .fmu-td{ border-top:0; }
.fmu-trMain.me .fmu-td{
        background:linear-gradient(180deg, rgba(var(--primary-rgb,217,48,37),0.08), rgba(var(--primary-rgb,217,48,37),0.03));
      }
.fmu-trMain.me .fmu-td:first-child{
        box-shadow: inset 4px 0 0 var(--primary-readable, var(--primary,#d93025));
      }
.fmu-trPerm.me .fmu-permShell{
        background:rgba(var(--primary-rgb,217,48,37),0.035);
      }
.fmu-userCell{ display:flex; align-items:center; gap:8px; width:100%; min-width:0; }
.fmu-userAvatar{
        position:relative;
        width:40px; height:40px;
        border-radius:12px;
        border:1px solid rgba(0,0,0,0.08);
        background:rgba(0,0,0,0.06);
        display:flex; align-items:center; justify-content:center;
        overflow:hidden;
        flex:0 0 auto;
        padding:0;
        color:rgba(0,0,0,0.45);
        font-size:16px;
        font-weight:800;
      }
button.fmu-userAvatar{
        cursor:pointer;
        transition:.15s ease;
      }
button.fmu-userAvatar:hover{
        border-color:rgba(0,0,0,0.16);
        background:rgba(0,0,0,0.08);
      }
.fmu-userAvatar img{
        width:100%; height:100%;
        object-fit:cover;
        display:block;
      }
.fmu-userAvatarEdit{
        position:absolute;
        right:2px; bottom:2px;
        width:16px; height:16px;
        border-radius:999px;
        background:#fff;
        border:1px solid rgba(0,0,0,0.12);
        display:flex; align-items:center; justify-content:center;
        font-size:8px;
        color:#555;
      }
.fmu-userAvatarStatic .fmu-userAvatarEdit{ display:none; }
.fmu-fileInput{ display:none !important; }
.fmu-userText{ flex:0 1 auto; min-width:0; }
.fmu-userName{ font-weight:1000; line-height:1.15; }
button.fmu-userName{border:0;background:transparent;padding:0;color:#101828;font:inherit;font-weight:1000;line-height:1.15;text-align:left;cursor:pointer}
button.fmu-userName:hover{color:var(--primary-readable,var(--primary,#d93025));text-decoration:underline}
.fmu-userEmail{ margin-top:4px; font-size:12px; font-weight:800; color:#666; line-height:1.15; }
.fmu-userCell .fmu-tag.you{ flex:0 0 auto; white-space:nowrap; }
.fmu-centerCell{ text-align:center; }
.fmu-centerCell .fmu-pill{ margin: 0 auto; }
.fmu-th.userHead{ text-align:left; }
.fmu-tag{
        display:inline-flex; align-items:center; gap:8px;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:999px;
        padding:6px 9px;
        font-weight:950; font-size:12px;
        background:#fff;
        color:#444;
      }
.fmu-tag.you{
        border-color: rgba(var(--primary-rgb,217,48,37),0.30);
        background: rgba(var(--primary-rgb,217,48,37),0.12);
        color: var(--primary-readable, var(--primary,#d93025));
        box-shadow: 0 8px 18px rgba(var(--primary-rgb,217,48,37),0.12);
      }
.fmu-pill{
        display:inline-flex; align-items:center; gap:8px;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:999px;
        padding:7px 10px;
        font-weight:950; font-size:12px;
        background:#fff;
        color:#444;
      }
.fmu-pill.active{ }
.fmu-pill.never{ border-color: rgba(var(--primary-rgb,217,48,37),0.35); var(--primary-readable, var(--primary,#d93025)); background: rgba(var(--primary-rgb,217,48,37),0.06); }
.fmu-pill.off{ opacity:.60; }
.fmu-pill.level{ border-color: rgba(0,0,0,0.14); background: rgba(0,0,0,0.02); }
.fmu-actionsCell{ width: 52px; padding-right: 10px; text-align:right; }
.fmu-kebab{
        border:1px solid rgba(0,0,0,0.14);
        background:#fff;
        border-radius:12px;
        padding:8px 10px;
        cursor:pointer;
        font-weight:1000;
        transition:.14s ease;
      }
.fmu-kebab:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
.fmu-fmenu{
        position:fixed;
        min-width: 200px;
        background:#fff;
        border:1px solid rgba(0,0,0,0.10);
        border-radius:14px;
        box-shadow: 0 18px 55px rgba(0,0,0,0.18);
        overflow:hidden;
        z-index: 2147483301;
        display:none;
      }
.fmu-fmenu.open{ display:block; }
.fmu-mi{
        width:100%;
        text-align:left;
        border:0;
        background:#fff;
        padding:12px 12px;
        font-weight:1000;
        cursor:pointer;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
      }
.fmu-mi:hover{ background: rgba(0,0,0,0.03); }
.fmu-mi.disabled{ opacity:.45; cursor:not-allowed; }
.fmu-mi.disabled:hover{ background:#fff; }
.fmu-trPerm td{ padding:0; border-top:0; }
.fmu-permShell{ border-top:1px solid rgba(0,0,0,0.06); background: rgba(0,0,0,0.015); }
.fmu-permWrap{
        overflow:hidden;
        max-height:0;
        opacity:0;
        transform:translateY(-4px);
        transition:max-height .18s ease, opacity .18s ease, transform .18s ease;
      }
.fmu-permWrap.open{
        max-height:340px;
        opacity:1;
        transform:none;
      }
.fmu-permInner{ padding: 10px 12px 12px; display:flex; flex-direction:column; gap:8px; }
.fmu-permTop{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.fmu-rolePresets{
        display:flex;
        flex-wrap:wrap;
        gap:6px;
        flex:1 1 auto;
      }
.fmu-roleBtn{
        border:1px solid rgba(0,0,0,0.10);
        background:#fff;
        border-radius:10px;
        padding:6px 10px;
        font-weight:800;
        font-size:11px;
        color:rgba(0,0,0,0.45);
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        gap:6px;
        line-height:1.2;
        transition:.15s ease;
      }
.fmu-roleBtn:hover{
        border-color:rgba(0,0,0,0.20);
        color:rgba(0,0,0,0.65);
      }
.fmu-roleBtn.active{
        border-color:var(--primary-readable, var(--primary,#d93025));
        background:rgba(var(--primary-readable-rgb, var(--primary-rgb,217,48,37)),0.08);
        color:var(--primary-readable, var(--primary,#d93025));
      }
.fmu-roleBtn.custom{
        border-style:dashed;
      }
.fmu-roleBtn:disabled{
        opacity:.55;
        cursor:not-allowed;
      }
.fmu-roleBtn:disabled:hover{
        border-color:rgba(0,0,0,0.10);
        color:rgba(0,0,0,0.45);
      }
.fmu-permHint{
        flex:1 1 220px;
        margin-left:auto;
        font-size:11px;
        font-weight:700;
        color:rgba(0,0,0,0.45);
        text-align:right;
      }
.fmu-permHint:empty{ display:none; }
.fmu-permGrid{
        display:flex;
        flex-wrap:wrap;
        gap:6px;
        padding-top:10px;
        border-top:1px dashed rgba(0,0,0,0.08);
      }
.fmu-permLabel{
        width:100%;
        font-size:10px;
        font-weight:700;
        letter-spacing:.5px;
        text-transform:uppercase;
        color:rgba(0,0,0,0.25);
        margin-bottom:2px;
      }
.fmu-pbtn{
        border:1px solid rgba(0,0,0,0.06);
        background:rgba(0,0,0,0.02);
        border-radius:8px;
        padding:5px 10px;
        font-weight:700;
        font-size:10px;
        cursor:pointer;
        transition:.15s ease;
        user-select:none;
        display:inline-flex;
        align-items:center;
        gap:5px;
        color:rgba(0,0,0,0.35);
        line-height:1.2;
      }
.fmu-pbtn:hover{
        border-color:rgba(0,0,0,0.15);
        color:rgba(0,0,0,0.5);
        background:rgba(0,0,0,0.03);
      }
.fmu-pbtn.on{
        border-color:var(--primary-readable, var(--primary,#d93025));
        background:rgba(var(--primary-readable-rgb, var(--primary-rgb,217,48,37)),0.08);
        color:var(--primary-readable, var(--primary,#d93025));
      }
.fmu-pbtn.on .dot{ background: var(--primary-readable, var(--primary,#d93025)); }
.fmu-pbtn .dot{
        width:7px; height:7px; border-radius:999px;
        background: rgba(0,0,0,0.12);
      }
.fmu-pbtn.ro{ cursor:not-allowed; opacity:0.8; }
.fmu-pbtn.ro:hover{
        border-color: rgba(0,0,0,0.06);
        color:rgba(0,0,0,0.35);
        background:rgba(0,0,0,0.02);
      }
.fmu-modalBack{ position:fixed; inset:0; background:rgba(0,0,0,0.42); display:flex; align-items:center; justify-content:center; z-index:2147483300; padding:14px; }
.fmu-modal{ display:flex; flex-direction:column; max-height:calc(100dvh - 28px); width:min(560px, 100%); background:#fff; border-radius:18px; border:1px solid rgba(0,0,0,0.10); box-shadow: 0 22px 70px rgba(0,0,0,0.22); overflow:hidden; }
.fmu-mh{ padding:14px 14px; display:flex; align-items:center; justify-content:space-between; gap:10px; border-bottom:1px solid rgba(0,0,0,0.08); }
.fmu-mt{ font-weight:1000; font-size:15px; }
.fmu-mx{ border:1px solid rgba(0,0,0,0.14); background:#fff; border-radius:12px; padding:8px 10px; cursor:pointer; font-weight:1000; }
.fmu-mx:hover{ border-var(--primary-readable, var(--primary,#d93025)); var(--primary-readable, var(--primary,#d93025)); }
.fmu-mb{ padding:14px; min-height:0; overflow:auto; }
.fmu-mh,.fmu-mactions{flex-shrink:0}
.fmu-msub{ font-size:12px; font-weight:850; color:#666; margin-top:4px; }
.fmu-rows{ display:grid; gap:10px; margin-top:12px; }
.fmu-row{ display:flex; flex-direction:column; gap:6px; }
.fmu-lbl{ font-size:11px; font-weight:950; color:#777; letter-spacing:.5px; text-transform:uppercase; }
.fmu-mactions{ padding:14px; border-top:1px solid rgba(0,0,0,0.08); display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap; }
.fmu-newAvatarRow{
        display:flex;
        justify-content:center;
        margin-bottom:2px;
      }
.fmu-newAvatarWrap{
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:8px;
      }
.fmu-newAvatarNote{
        font-size:11px;
        font-weight:700;
        color:rgba(0,0,0,0.42);
        text-align:center;
      }
@media (max-width: 820px){.cs-actions .fmu-shared-btn{
          width:100%;
          justify-content:center;
        }
.fmu-shared-in{
          padding:14px 12px;
          font-size:16px; 
          border-radius:12px;
        }
.fmu-top{
          flex-direction:column;
          align-items:stretch;
          gap:10px;
        }
.fmu-actions{
          justify-content:flex-start;
        }
.fmu-table{
          border-radius:14px;
        }
.fmu-th{
          display:none;
        }
.fmu-trMain{
          display:flex !important;
          flex-wrap:wrap;
          align-items:center;
          gap:6px 8px;
          padding:12px 44px 12px 12px;
          border-top:1px solid rgba(0,0,0,0.06);
          position:relative;
        }
.fmu-trMain:first-child{border-top:0}
.fmu-trMain .fmu-td{
          padding:0;
          border-top:0 !important;
          display:flex;
          align-items:center;
          gap:8px;
        }
.fmu-trMain .fmu-td:first-child{
          flex:1 1 100%;
          min-width:0;
        }
.fmu-centerCell{
          flex:0 0 auto;
          text-align:left;
        }
.fmu-centerCell .fmu-pill{
          margin:0;
          font-size:11px;
          padding:4px 8px;
        }
.fmu-actionsCell{
          position:absolute !important;
          top:12px;
          right:8px;
          width:auto;
          padding:0;
        }
.fmu-trPerm{
          display:block;
        }
.fmu-trPerm td{
          display:block !important;
        }
.fmu-permWrap.open{
          max-height:520px;
        }
.fmu-permInner{
          padding:10px 8px 12px;
        }
.fmu-permTop{
          flex-direction:column;
          align-items:stretch;
          gap:8px;
        }
.fmu-rolePresets{
          width:100%;
        }
.fmu-roleBtn{
          justify-content:center;
          flex:1 1 calc(50% - 6px);
        }
.fmu-roleBtn.custom{
          flex-basis:100%;
        }
.fmu-permHint{
          flex:0 0 auto;
          margin-left:0;
          text-align:left;
        }
.fmu-permGrid{
          gap:6px;
        }
.fmu-pbtn{
          font-size:11px;
          padding:8px 8px;
        }
.fmu-fmenu{
          left:8px !important;
          right:8px !important;
          bottom:8px !important;
          top:auto !important;
          width:auto !important;
          min-width:0;
          border-radius:16px;
        }
.fmu-mi{
          padding:14px 14px;
          font-size:14px;
        }
.fmu-modalBack{
          padding:8px;
          align-items:flex-end;
        }
.fmu-modal{
          width:100%;
          max-height:92vh;
          border-radius:16px 16px 0 0;
        }
.fmu-mb{
          padding:12px;
        }
.fmu-mb .fmu-shared-in{
          font-size:16px;
        }
.fmu-mactions{
          padding:12px;
          flex-direction:column;
        }
.fmu-mactions .fmu-shared-btn{
          width:100%;
          justify-content:center;
        }
.ms-actions .fmu-shared-btn{
          width:100%;
          justify-content:center;
        }
.ms-mFooter .fmu-shared-btn{
          width:100%;
          justify-content:center;
        }
.fmu-table{
          min-width:0;
          max-width:100%;
          box-sizing:border-box;
        }
.fmu-actions{
          display:grid;
          grid-template-columns:repeat(2,minmax(0,1fr));
          gap:7px;
        }
.fmu-actions .fmu-btn{
          min-width:0;
          width:100%;
          justify-content:center;
          padding:9px 8px;
          font-size:11px;
          gap:6px;
          white-space:nowrap;
        }
.fmu-actions .fmu-btn:nth-child(3){
          grid-column:1/-1;
        }
.fmu-actions .fmu-btn:first-child:last-child{
          grid-column:1/-1;
        }
.fmu-table,.fmu-table tbody,.fmu-trMain,.fmu-trPerm{
          box-sizing:border-box;
          display:block;
          width:100%;
        }
.fmu-table{
          border:0;
          border-radius:0;
          overflow:visible;
          background:transparent;
        }
.fmu-trMain{
          margin:0 0 8px;
          border:1px solid rgba(0,0,0,0.08);
          border-radius:14px;
          background:#fff;
          box-shadow:0 8px 18px rgba(15,23,42,.04);
        }
.fmu-trMain.me .fmu-td{background:transparent;}
.fmu-trMain.me .fmu-td:first-child{box-shadow:none;}
.fmu-trMain.me{
          background:rgba(var(--primary-rgb,217,48,37),.045);
          border-color:rgba(var(--primary-rgb,217,48,37),.18);
          box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.06);
        }
.fmu-userCell{
          display:grid;
          grid-template-columns:40px minmax(0,1fr);
          align-items:start;
          gap:5px 10px;
        }
.fmu-userAvatar{
          grid-row:1 / span 2;
          width:40px;
          height:40px;
          border-radius:11px;
          font-size:14px;
        }
.fmu-userText{
          flex:1 1 auto;
          overflow:hidden;
        }
.fmu-userName,button.fmu-userName,.fmu-userEmail{
          max-width:100%;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }
.fmu-userName,button.fmu-userName{
          white-space:normal;
          overflow-wrap:anywhere;
          line-height:1.35;
          font-size:13px;
        }
.fmu-userEmail{
          font-size:11px;
          margin-top:3px;
        }
.fmu-userCell .fmu-tag.you{
          position:static;
          grid-column:2;
          justify-self:start;
          padding:4px 7px;
          font-size:10px;
          gap:4px;
        }
.fmu-centerCell{
          max-width:calc(50% - 4px);
        }
.fmu-centerCell .fmu-pill{
          max-width:100%;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }
.fmu-kebab{
          width:32px;
          height:32px;
          padding:0;
          display:grid;
          place-items:center;
          border-radius:10px;
        }
.fmu-permShell{
          box-sizing:border-box;
          width:100%;
          margin:-8px 0 14px;
          border:1px solid rgba(0,0,0,0.08);
          border-top:0;
          border-radius:0 0 14px 14px;
          background:#fbfcfe;
          overflow:hidden;
        }
.fmu-permWrap.open{
          max-height:none;
        }
.fmu-permInner{
          padding:14px 12px;
          gap:14px;
        }
.fmu-rolePresets{
          flex:0 0 auto;
          display:grid;
          grid-template-columns:repeat(2,minmax(0,1fr));
          gap:6px;
        }
.fmu-roleBtn,.fmu-roleBtn.custom{
          min-height:36px;
          min-width:0;
          flex-basis:auto;
          padding:7px 6px;
          font-size:10.5px;
          gap:4px;
        }
.fmu-roleBtn.custom{
          grid-column:1/-1;
        }
.fmu-permGrid{
          display:grid;
          grid-template-columns:repeat(2,minmax(0,1fr));
        }
.fmu-permLabel{
          grid-column:1/-1;
        }
.fmu-roleBtn:disabled{opacity:1;color:#667085;background:#f8f9fb;}
.fmu-roleBtn.active:disabled{color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.08);}
.fmu-pbtn.ro:not(.on){opacity:1;color:#667085;background:#f8f9fb;}
.fmu-pbtn{
          min-height:40px;
          text-align:left;
          justify-content:flex-start;
          min-width:0;
          overflow:hidden;
        }
.fmu-pbtn span:last-child{
          min-width:0;
          white-space:normal;
          overflow-wrap:anywhere;
        }
.fmu-fmenu{
          bottom:calc(8px + var(--referral-mobile-inset,0px)) !important;
          max-height:calc(100dvh - 24px - var(--referral-mobile-inset,0px));
          overflow:auto;
        }
.fmu-modalBack{
          bottom:var(--referral-mobile-inset,0px);
        }
.fmu-modal{
          max-height:calc(100dvh - 16px - var(--referral-mobile-inset,0px));
          display:flex;
          flex-direction:column;
        }
.fmu-mb{
          overflow:auto;
          -webkit-overflow-scrolling:touch;
        }
.bl-card > .bl-row:first-child .fmu-shared-btn{
          min-height:36px;
          padding:9px 10px;
          white-space:nowrap;
        }
.bl-card .cs-actions .fmu-shared-btn{
          width:100%;
          justify-content:center;
          min-height:38px;
          padding:9px 10px;
          font-size:12px;
        }
}
@media (max-width: 380px){.fmu-pbtn{
          font-size:10px;
          padding:6px 6px;
        }
}
`);
    // **** Users pane ----
    const canAddDelete = hasPerm('manage_company_users');
    const canManagePerms = hasPerm('manage_company_user_permissions');
    if (canUsers && paneUsers) {
      paneUsers.innerHTML = `
        <div class="fmu-top">
          <div>
            <div class="fmu-title">${(globalThis.PlatformLanguage?.htmlText("settings","m_50ab7fe67b1e45","Users") ?? "Users")}</div>
            <div class="fmu-shared-note">${(globalThis.PlatformLanguage?.htmlText("settings","m_58fd0b9648f343","Invite users, manage access, and edit permissions.") ?? "Invite users, manage access, and edit permissions.")}</div>
          </div>
          <div class="fmu-actions">
            ${String(canAddDelete ? `<button class="fmu-btn" id="cuAdd"><i class="fas fa-user-plus"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_e09715b775ce9e"," Add user") ?? " Add user")}</button>` : '')}
            <button class="fmu-btn toggle ${String(usersState.showPerms ? 'on' : '')}" id="cuPerms" type="button" aria-pressed="${String(usersState.showPerms ? 'true' : 'false')}"><i class="fas ${String(usersState.showPerms ? 'fa-toggle-on' : 'fa-toggle-off')}"></i> ${String(usersState.showPerms ? 'Hide permissions' : 'Show permissions')}</button>
            <button class="fmu-btn" id="cuReload"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_99dd7eb1fa4719"," Reload") ?? " Reload")}</button>
          </div>
        </div>
        <div id="cuMsg" class="fmu-shared-note"></div>
        <table class="fmu-table">
          <thead><tr>
            <th class="fmu-th userHead">${(globalThis.PlatformLanguage?.htmlText("settings","m_dfd6687ea85fad","User") ?? "User")}</th>
            <th class="fmu-th">${(globalThis.PlatformLanguage?.htmlText("settings","m_aebe4495d54bc2","Permission Level") ?? "Permission Level")}</th>
            <th class="fmu-th">${(globalThis.PlatformLanguage?.htmlText("settings","m_1352cafa75b8da","Status") ?? "Status")}</th>
            <th class="fmu-th" style="width:56px;"></th>
          </tr></thead>
          <tbody id="cuBody"></tbody>
        </table>
      `;
    }
    // **** Floating menu element (users) ----
    floatingMenu = document.createElement('div');
    floatingMenu.className = 'fmu-fmenu';
    document.body.appendChild(floatingMenu);
    function closeFloatingMenu(){
      if (!floatingMenu) return;
      floatingMenu.classList.remove('open');
      floatingMenu.style.display = 'none';
      floatingMenu.innerHTML = '';
      usersState.openMenuUserId = null;
    }
    document.addEventListener('click', (e)=>{
      if (paneUsers && !paneUsers.classList.contains('active')) return;
      const t = e.target;
      if (!t) return;
      if (t.closest && t.closest('.fmu-fmenu')) return;
      if (t.closest && t.closest('button[data-act="kebab"]')) return;
      closeFloatingMenu();
    }, { signal: lifecycle.signal });
    document.addEventListener('keydown', (e)=>{
      if (paneUsers && !paneUsers.classList.contains('active')) return;
      if (e.key === 'Escape') closeFloatingMenu();
    }, { signal: lifecycle.signal });
    // **** Users UI ----
    const cuMsg = $('#cuMsg', paneUsers);
    const cuBody = $('#cuBody', paneUsers);
    function getUsersMsgEl(){ return paneUsers ? $('#cuMsg', paneUsers) : null; }
    function getUsersBodyEl(){ return paneUsers ? $('#cuBody', paneUsers) : null; }
    function modal({ title, subtitle, bodyHtml, onClose }){
      const back = document.createElement('div');
      back.className = 'fmu-modalBack';
      back.innerHTML = `
        <div class="fmu-modal" role="dialog" aria-modal="true">
          <div class="fmu-mh">
            <div>
              <div class="fmu-mt">${escapeHtml(title || 'Modal')}</div>
              ${subtitle ? `<div class="fmu-msub">${escapeHtml(subtitle)}</div>` : ''}
            </div>
            <button class="fmu-mx" type="button"><i class="fas fa-xmark"></i></button>
          </div>
          <div class="fmu-mb">${bodyHtml || ''}</div>
        </div>
      `;
      const close = ()=>{
        openModals.delete(close);
        back.remove();
        if (typeof onClose === 'function') onClose();
      };
      let downOnBackdrop = false;
      back.addEventListener('mousedown', (e)=>{ downOnBackdrop = (e.target === back); });
      back.addEventListener('mouseup', (e)=>{ if (downOnBackdrop && e.target === back) close(); downOnBackdrop = false; });
      back.querySelector('.fmu-mx').addEventListener('click', close);
      document.body.appendChild(back);
      openModals.add(close);
      return { el: back, close };
    }
    function computeSuperAdmins(users){
      const supers = [];
      for (const u of (users || [])){
        if (u?.deleted) continue;
        if (normLevel(u) === 'super_admin') supers.push(normEmail(u));
      }
      return supers;
    }
    function guardInfoForUser(u, superAdmins){
      const email = normEmail(u);
      const lvl = normLevel(u);
      const isMe = (ME_EMAIL && email === ME_EMAIL);
      const isSuper = (lvl === 'super_admin');
      const superCount = (superAdmins || []).length;
      const isLastSuper = isSuper && superCount === 1;
      return { isMe, isSuper, isLastSuper, superCount };
    }
    function pickStatus(u){
      if (u?.deleted)  return { t:'Deleted',   cls:'off', ico:'fa-trash' };
      if (u?.disabled) return { t:'Suspended', cls:'off', ico:'fa-pause' };
      const rawStatus = String(u?.status || '').trim().toLowerCase();
      const neverSignedIn = u?.never_signed_in === true || (!u?.last_login_at && ['invited', 'pending'].includes(rawStatus));
      if (neverSignedIn) return { t:'Never signed in', cls:'never', ico:'fa-envelope-open-text' };
      if (rawStatus === 'invited' || rawStatus === 'pending') return { t:'Invited', cls:'never', ico:'fa-paper-plane' };
      return { t:'Active', cls:'active', ico:'fa-circle-check' };
    }
    function openEditUserModal(u){
      const isMe = normEmail(u) === ME_EMAIL;
      const isSuperAdmin = normLevel(u) === 'super_admin';
      const lockedEmailMsg = "Super admin emails can't be edited to avoid account lockouts.";
      const m = modal({
        title: (globalThis.PlatformLanguage?.text("settings","m_42cbeb12c23c5f","Edit user") ?? "Edit user"),
        subtitle: isSuperAdmin
          ? 'You can rename this super admin, but the email is locked.'
          : (isMe ? 'Update your displayed name or sign-in email.' : 'Rename the user or change their email.'),
        bodyHtml: `
          <div class="fmu-rows">
            <div class="fmu-row">
              <div class="fmu-lbl">Name</div>
              <input class="fmu-shared-in" id="cuEditName" placeholder="Jane Doe" autocomplete="off" value="${escapeHtml(String(u?.name || ''))}">
            </div>
            <div class="fmu-row">
              <div class="fmu-lbl">Email</div>
              <input class="fmu-shared-in" id="cuEditEmail" placeholder="jane.doe@company.com" autocomplete="off" inputmode="email" value="${escapeHtml(String(u?.email || ''))}" ${isSuperAdmin ? 'readonly aria-readonly="true"' : ''}>
              ${isSuperAdmin ? `<div class="fmu-shared-note" style="margin-top:2px;">${escapeHtml(lockedEmailMsg)}</div>` : ''}
            </div>
          </div>
          <div class="fmu-shared-note" id="cuEditStatus" style="margin-top:10px;"></div>
        `
      });
      const footer = document.createElement('div');
      footer.className = 'fmu-mactions';
      footer.innerHTML = `
        <button class="fmu-shared-btn ghost" type="button"><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_842e54dc81e3fa"," Cancel") ?? " Cancel")}</button>
        <button class="fmu-shared-btn primary" type="button"><i class="fas fa-save"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_bfcbd339764266"," Save changes") ?? " Save changes")}</button>
      `;
      m.el.querySelector('.fmu-modal').appendChild(footer);
      const elName = m.el.querySelector('#cuEditName');
      const elEmail = m.el.querySelector('#cuEditEmail');
      const elStatus = m.el.querySelector('#cuEditStatus');
      const [btnCancel, btnSave] = footer.querySelectorAll('button');
      btnCancel.addEventListener('click', ()=>m.close());
      btnSave.addEventListener('click', async ()=>{
        const name = String(elName?.value || '').trim();
        const email = String(elEmail?.value || '').trim().toLowerCase();
        if (isSuperAdmin && email !== String(u?.email || '').trim().toLowerCase()){
          showToast((globalThis.PlatformLanguage?.text("settings","m_e6ae16ead43bae","Not allowed") ?? "Not allowed"), lockedEmailMsg, false);
          return;
        }
        if (!email || !email.includes('@')){
          showToast((globalThis.PlatformLanguage?.text("settings","m_3d139aa9918a1e","Missing email") ?? "Missing email"), (globalThis.PlatformLanguage?.text("settings","m_966872f2233bc5","Please enter a valid email.") ?? "Please enter a valid email."), false);
          return;
        }
        btnSave.disabled = true;
        elStatus.textContent = (globalThis.PlatformLanguage?.text("settings","m_7372b758cf9670","Saving changes...") ?? "Saving changes...");
        const ret = await userUpdate({ userId: u.id, email, name });
        btnSave.disabled = false;
        elStatus.textContent = '';
        if (!ret.ok){
          showToast((globalThis.PlatformLanguage?.text("settings","m_c8b7bd7ca69f49","Save failed") ?? "Save failed"), ret.error || '-', false);
          return;
        }
        m.close();
        if (ret.sessionUpdated || isMe){
          showToast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"), (globalThis.PlatformLanguage?.text("settings","m_9b3d76ac15b3d4","Your profile was updated. Reloading settings...") ?? "Your profile was updated. Reloading settings..."), true);
          setTimeout(()=>window.location.reload(), 120);
          return;
        }
        showToast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"), (globalThis.PlatformLanguage?.text("settings","m_4f9afa9829c47c","User updated.") ?? "User updated."), true);
        refreshUsers();
      });
    }
    function renderActionsMenuForUser(u, anchorBtn){
      if (!floatingMenu) return;
      closeFloatingMenu();
      const superAdmins = usersState.superAdmins || [];
      const { isMe, isSuper } = guardInfoForUser(u, superAdmins);
      const canEdit = canAddDelete && !u?.deleted;
      const canResend = canAddDelete && !u?.deleted && !u?.disabled && !!normEmail(u);
      const canSuspend = canAddDelete && !(isMe || isSuper);
      const canDelete  = canAddDelete && !(isMe || isSuper);
      const suspendLabel = u?.disabled ? 'Unsuspend' : 'Suspend';
      const suspendIcon  = u?.disabled ? 'fa-play' : 'fa-pause';
      floatingMenu.innerHTML = `
        <button class="fmu-mi ${String(canEdit ? '' : 'disabled')}" type="button" data-act="edit" ${String(canEdit ? '' : 'disabled')}>
          <span>${(globalThis.PlatformLanguage?.htmlText("settings","m_5b9378df7220c1","Edit") ?? "Edit")}</span>
          <i class="fas fa-pen"></i>
        </button>
        <button class="fmu-mi ${String(canResend ? '' : 'disabled')}" type="button" data-act="resend" ${String(canResend ? '' : 'disabled')}>
          <span>${(globalThis.PlatformLanguage?.htmlText("settings","m_ff95e546b6a785","Resend invite") ?? "Resend invite")}</span>
          <i class="fas fa-paper-plane"></i>
        </button>
        <button class="fmu-mi ${String(canSuspend ? '' : 'disabled')}" type="button" data-act="suspend" ${String(canSuspend ? '' : 'disabled')}>
          <span>${String(escapeHtml(suspendLabel))}</span>
          <i class="fas ${String(suspendIcon)}"></i>
        </button>
        <button class="fmu-mi ${String(canDelete ? '' : 'disabled')}" type="button" data-act="delete" ${String(canDelete ? '' : 'disabled')}>
          <span>${(globalThis.PlatformLanguage?.htmlText("settings","m_4fc60207629a44","Delete") ?? "Delete")}</span>
          <i class="fas fa-trash"></i>
        </button>
      `;
      const rect = anchorBtn.getBoundingClientRect();
      const pad = 8;
      floatingMenu.style.display = 'block';
      floatingMenu.classList.add('open');
      let left = Math.round(rect.right - 200);
      let top = Math.round(rect.bottom + pad);
      const mrect = floatingMenu.getBoundingClientRect();
      left = Math.max(pad, Math.min(left, window.innerWidth - mrect.width - pad));
      if (top + mrect.height + pad > window.innerHeight) {
        top = Math.max(pad, Math.round(rect.top - mrect.height - pad));
      }
      floatingMenu.style.left = left + 'px';
      floatingMenu.style.top = top + 'px';
      usersState.openMenuUserId = String(u?.id || '');
      const btnEdit = floatingMenu.querySelector('[data-act="edit"]');
      const btnResend = floatingMenu.querySelector('[data-act="resend"]');
      const btnSuspend = floatingMenu.querySelector('[data-act="suspend"]');
      const btnDelete  = floatingMenu.querySelector('[data-act="delete"]');
      if (btnEdit){
        btnEdit.addEventListener('click', ()=>{
          closeFloatingMenu();
          if (!canEdit){
            showToast((globalThis.PlatformLanguage?.text("settings","m_e6ae16ead43bae","Not allowed") ?? "Not allowed"), (globalThis.PlatformLanguage?.text("settings","m_d7db061660b1a2","Deleted users cannot be edited.") ?? "Deleted users cannot be edited."), false);
            return;
          }
          openEditUserModal(u);
        });
      }
      if (btnResend){
        btnResend.addEventListener('click', async ()=>{
          closeFloatingMenu();
          if (!canResend){
            showToast((globalThis.PlatformLanguage?.text("settings","m_e6ae16ead43bae","Not allowed") ?? "Not allowed"), (globalThis.PlatformLanguage?.text("settings","m_65dce0f294b9ab","This user cannot receive an invite email.") ?? "This user cannot receive an invite email."), false);
            return;
          }
          showToast((globalThis.PlatformLanguage?.text("settings","m_91318c0f3dbca8","Sending invite") ?? "Sending invite"), (globalThis.PlatformLanguage?.text("settings","m_e08b0904a135dd","Sending activation email...") ?? "Sending activation email..."), true);
          const ret = await userResendInvite({ userId: u.id });
          if (!ret.ok){
            if (ret.activate_url) {
              try{ navigator.clipboard.writeText(ret.activate_url); }catch(e){}
            }
            showToast((globalThis.PlatformLanguage?.text("settings","m_88586c062e2d41","Invite failed") ?? "Invite failed"), ret.error || 'Could not send invite email.', false);
            return;
          }
          showToast((globalThis.PlatformLanguage?.text("settings","m_56cd43e2daebec","Invite sent") ?? "Invite sent"), (globalThis.PlatformLanguage?.text("settings","m_eb7d39af41ae8e","Activation email sent.") ?? "Activation email sent."), true);
          refreshUsers();
        });
      }
      if (btnSuspend){
        btnSuspend.addEventListener('click', async ()=>{
          closeFloatingMenu();
          if (!canSuspend){
            showToast((globalThis.PlatformLanguage?.text("settings","m_e6ae16ead43bae","Not allowed") ?? "Not allowed"), isMe ? "You can't suspend yourself." : "You can't suspend a Super Admin.", false);
            return;
          }
          const wantDisabled = !u.disabled;
          const ret = await userSetDisabled({ userId: u.id, disabled: wantDisabled });
          if (!ret.ok){
            showToast((globalThis.PlatformLanguage?.text("settings","m_ec71d30ae4424e","Update failed") ?? "Update failed"), ret.error || '-', false);
            return;
          }
          showToast((globalThis.PlatformLanguage?.text("settings","m_6a171239c315c1","Updated") ?? "Updated"), wantDisabled ? 'User suspended.' : 'User unsuspended.', true);
          refreshUsers();
        });
      }
      if (btnDelete){
        btnDelete.addEventListener('click', async ()=>{
          closeFloatingMenu();
          if (!canDelete){
            showToast((globalThis.PlatformLanguage?.text("settings","m_e6ae16ead43bae","Not allowed") ?? "Not allowed"), isMe ? "You can't delete yourself." : "You can't delete a Super Admin.", false);
            return;
          }
          const label = `${u.name || u.email || 'User'} (${u.email || ''})`;
          const m = modal({
            title: (globalThis.PlatformLanguage?.text("settings","m_7449aed6d9c4b8","Soft delete user?") ?? "Soft delete user?"),
            subtitle: (globalThis.PlatformLanguage?.text("settings","m_86556b237c82e1","They will be blocked from logging in, hidden from your Users list, and their email will become available again.") ?? "They will be blocked from logging in, hidden from your Users list, and their email will become available again."),
            bodyHtml: `
              <div class="fmu-shared-note" style="margin-top:0;">This is a soft delete. The account is archived for audit, and the email can be reused for a future invite or signup.</div>
              <div class="fmu-shared-note" style="margin-top:10px;">${escapeHtml(label)}</div>
            `
          });
          const footer = document.createElement('div');
          footer.className = 'fmu-mactions';
          footer.innerHTML = `
            <button class="fmu-shared-btn ghost" type="button"><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_842e54dc81e3fa"," Cancel") ?? " Cancel")}</button>
            <button class="fmu-shared-btn primary" type="button"><i class="fas fa-trash"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_90e27d705bee80"," Delete") ?? " Delete")}</button>
          `;
          m.el.querySelector('.fmu-modal').appendChild(footer);
          const [btnCancel, btnDo] = footer.querySelectorAll('button');
          btnCancel.addEventListener('click', ()=>m.close());
          btnDo.addEventListener('click', async ()=>{
            btnDo.disabled = true;
            const ret = await userSoftDelete({ userId: u.id });
            btnDo.disabled = false;
            if (!ret.ok){
              showToast((globalThis.PlatformLanguage?.text("settings","m_cf2c70cfda409b","Delete failed") ?? "Delete failed"), ret.error || '-', false);
              return;
            }
            m.close();
            showToast((globalThis.PlatformLanguage?.text("settings","m_b244b99b91d25b","Deleted") ?? "Deleted"), (globalThis.PlatformLanguage?.text("settings","m_1371d81a425675","User soft-deleted and email released.") ?? "User soft-deleted and email released."), true);
            refreshUsers();
          });
        });
      }
    }
    function renderUsersTable(){
      const msgEl = getUsersMsgEl();
      const bodyEl = getUsersBodyEl();
      const users = [...(usersState.list || [])].sort((a, b) => {
        const aMe = normEmail(a) === ME_EMAIL ? 1 : 0;
        const bMe = normEmail(b) === ME_EMAIL ? 1 : 0;
        if (aMe !== bMe) return bMe - aMe;
        const aName = String(a?.name || a?.email || '').toLowerCase();
        const bName = String(b?.name || b?.email || '').toLowerCase();
        return aName.localeCompare(bName);
      });
      const superAdmins = usersState.superAdmins || [];
      if (msgEl) msgEl.textContent = users.length ? '' : 'No users found.';
      const rows = [];
      for (const u of users){
        const id = String(u.id || '');
        const name = String(u.name || u.email || id);
        const email = String(u.email || '');
        const lvl = normLevel(u) || 'viewer';
        const { isMe, isLastSuper } = guardInfoForUser(u, superAdmins);
        const st = pickStatus(u);
        const levelText = levelLabel(lvl);
        const isDeleted = !!u?.deleted;
        const lockLevel = isDeleted || isLastSuper || isMe || !canManagePerms;
        const effectiveItems = effectiveOrLocalPermsForUser(u, id);
        const roleButtonsHtml = renderRolePresetButtons(lvl, lockLevel);
        const ro = isDeleted || lockLevel || !canManagePerms;
        const permBtns = renderPermissionButtons(effectiveItems, ro);
        const canShowKebab = canAddDelete && !isDeleted;
        const avatarUrl = userAvatarUrl(u);
        const avatarInitial = userInitial(name, email);
        const canUploadAvatar = canAddDelete && !isDeleted;
        const avatarHtml = avatarUrl
          ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)}">`
          : `<span>${escapeHtml(avatarInitial)}</span>`;
        const avatarControl = canUploadAvatar
          ? `<button class="fmu-userAvatar" type="button" data-act="avatar" data-user-id="${escapeHtml(id)}" data-fm-tooltip="Upload profile picture">${avatarHtml}<span class="fmu-userAvatarEdit"><i class="fas fa-camera"></i></span></button><input class="fmu-fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-act="avatar-input" data-user-id="${escapeHtml(id)}">`
          : `<button class="fmu-userAvatar fmu-userAvatarStatic" type="button" data-act="open-user" data-user-id="${escapeHtml(id)}" data-fm-tooltip="Open profile">${avatarHtml}</button>`;
        rows.push(`
          <tr class="fmu-trMain ${String(isMe ? 'me' : '')}" data-user-id="${String(escapeHtml(id))}" style="${String(isDeleted ? 'opacity:.55;' : '')}">
            <td class="fmu-td">
              <div class="fmu-userCell">
                ${String(avatarControl)}
                <div class="fmu-userText">
                  <button class="fmu-userName fmu-userOpen" type="button" data-act="open-user" data-user-id="${String(escapeHtml(id))}"><span>${String(escapeHtml(name))}</span></button>
                  <div class="fmu-userEmail">${String(escapeHtml(email))}</div>
                </div>
                ${String(isMe ? `<span class="fmu-tag you"><i class="fas fa-user"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_77a0c5b9d8ac90"," You") ?? " You")}</span>` : '')}
              </div>
            </td>
            <td class="fmu-td fmu-centerCell">
              <span class="fmu-pill level"><i class="fas fa-shield-halved"></i> ${String(escapeHtml(levelText))}</span>
            </td>
            <td class="fmu-td fmu-centerCell">
              <span class="fmu-pill ${String(st.cls)}"><i class="fas ${String(st.ico)}"></i> ${String(escapeHtml(st.t))}</span>
            </td>
            <td class="fmu-td fmu-actionsCell">
              ${String(canShowKebab ? `<button class="fmu-kebab" type="button" data-act="kebab" aria-label="${(globalThis.PlatformLanguage?.htmlText("settings","m_6067958dea3386","Actions") ?? "Actions")}"><i class="fas fa-ellipsis-vertical"></i></button>` : '')}
            </td>
          </tr>
          <tr class="fmu-trPerm ${String(isMe ? 'me' : '')}" data-user-id="${String(escapeHtml(id))}" data-deleted="${String(isDeleted ? '1' : '0')}" style="${String(isDeleted || !usersState.showPerms ? 'display:none;' : '')}">
            <td colspan="4" class="fmu-permShell">
              <div class="fmu-permWrap ${String(usersState.showPerms ? 'open' : '')}">
                <div class="fmu-permInner">
                  <div class="fmu-permTop">
                    <div class="fmu-rolePresets" data-rolepresets>
                      ${String(roleButtonsHtml)}
                    </div>
                    <div class="fmu-permHint">
                      ${String(isMe ? 'You cannot edit your own permissions here.' : permissionHintText(lvl, canManagePerms))}
                    </div>
                  </div>
                  <div class="fmu-permGrid">
                    <div class="fmu-permLabel">${(globalThis.PlatformLanguage?.htmlText("settings","m_0ded144729a113","Permissions") ?? "Permissions")}</div>
                    ${String(permBtns)}
                  </div>
                </div>
              </div>
            </td>
          </tr>
        `);
      }
      if (bodyEl) {
        bodyEl.innerHTML = rows.join('');
        wireUsersTableHandlers();
      }
    }
    function syncUsersPermissionsUi(){
      if (paneUsers) {
        const btnPerms = $('#cuPerms', paneUsers);
        if (btnPerms){
          btnPerms.classList.toggle('on', usersState.showPerms);
          btnPerms.setAttribute('aria-pressed', usersState.showPerms ? 'true' : 'false');
          btnPerms.innerHTML = `<i class="fas ${usersState.showPerms ? 'fa-toggle-on' : 'fa-toggle-off'}"></i> ${usersState.showPerms ? 'Hide permissions' : 'Show permissions'}`;
        }
      }
      const bodyEl = getUsersBodyEl();
      if (!bodyEl) return;
      bodyEl.querySelectorAll('tr.fmu-trPerm').forEach(tr=>{
        const isDeleted = tr.getAttribute('data-deleted') === '1';
        tr.style.display = (usersState.showPerms && !isDeleted) ? '' : 'none';
      });
      bodyEl.querySelectorAll('.fmu-permWrap').forEach(w=>{
        w.classList.toggle('open', usersState.showPerms);
      });
    }
    function setPermControlsDisabled(tr, disabled){
      if (!tr) return;
      tr.querySelectorAll('button[data-role], button[data-perm]').forEach(btn=>{
        btn.disabled = !!disabled;
      });
    }
    function wireUsersTableHandlers(){
      const bodyEl = getUsersBodyEl();
      if(!bodyEl) return;
      const superAdmins = usersState.superAdmins || [];
      bodyEl.querySelectorAll('tr.fmu-trMain').forEach(tr=>{
        const userId = tr.getAttribute('data-user-id') || '';
        const u = usersState.list.find(x => String(x?.id || '') === String(userId));
        if (!u) return;
        const kebab = tr.querySelector('button[data-act="kebab"]');
        const avatarBtn = tr.querySelector('button[data-act="avatar"]');
        const avatarInput = tr.querySelector('input[data-act="avatar-input"]');
        tr.querySelectorAll('button[data-act="open-user"]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.Portal?.PhotoFeed?.openUserModal?.({
              id: u.id || userId,
              name: u.name || u.email || userId,
              email: u.email || '',
              avatar: userAvatarUrl(u),
              raw: u
            }, []);
          });
        });
        if (kebab){
          kebab.addEventListener('click', (e)=>{
            e.preventDefault();
            e.stopPropagation();
            renderActionsMenuForUser(u, kebab);
          });
        }
        if (avatarBtn && avatarInput){
          avatarBtn.addEventListener('click', ()=>{
            avatarInput.value = '';
            avatarInput.click();
          });
          avatarInput.addEventListener('change', async ()=>{
            const file = avatarInput.files && avatarInput.files[0];
            if (!file) return;
            showToast((globalThis.PlatformLanguage?.text("settings","m_7bad5a46bb7de0","Uploading") ?? "Uploading"), (globalThis.PlatformLanguage?.text("settings","m_81ff8eabf534d7","Saving profile picture...") ?? "Saving profile picture..."), true);
            const ret = await uploadUserAvatar({ userId, file });
            avatarInput.value = '';
            if (!ret.ok){
              showToast((globalThis.PlatformLanguage?.text("settings","m_eba695c553b0b3","Upload failed") ?? "Upload failed"), ret.error || 'Could not save profile picture.', false);
              return;
            }
            showToast((globalThis.PlatformLanguage?.text("settings","m_6a171239c315c1","Updated") ?? "Updated"), (globalThis.PlatformLanguage?.text("settings","m_7df2d88a99dcfa","Profile picture saved.") ?? "Profile picture saved."), true);
            refreshUsers();
          });
        }
      });
      if (canManagePerms) {
        bodyEl.querySelectorAll('tr.fmu-trPerm').forEach(tr=>{
          const userId = tr.getAttribute('data-user-id') || '';
          const u = usersState.list.find(x => String(x?.id || '') === String(userId));
          if (!u) return;
          const roleBtns = Array.from(tr.querySelectorAll('button[data-role]'));
          const permBtns = Array.from(tr.querySelectorAll('button[data-perm]'));
          const { isLastSuper } = guardInfoForUser(u, superAdmins);
          let saveInFlight = false;
          roleBtns.forEach(btn=>{
            btn.addEventListener('click', async ()=>{
              if (saveInFlight) return;
              const uNow = usersState.list.find(x => String(x?.id || '') === String(userId));
              if (!uNow) return;
              const next = String(btn.getAttribute('data-role') || 'viewer').toLowerCase().trim();
              const current = normLevel(uNow) || 'viewer';
              if (next === current) return;
              if (isLastSuper && next !== 'super_admin'){
                showToast((globalThis.PlatformLanguage?.text("settings","m_e6ae16ead43bae","Not allowed") ?? "Not allowed"), (globalThis.PlatformLanguage?.text("settings","m_27b3d11aed65b1","You must keep at least one Super Admin.") ?? "You must keep at least one Super Admin."), false);
                return;
              }
              if (current === 'super_admin' && next !== 'super_admin' && (usersState.superAdmins || []).length <= 1){
                showToast((globalThis.PlatformLanguage?.text("settings","m_e6ae16ead43bae","Not allowed") ?? "Not allowed"), (globalThis.PlatformLanguage?.text("settings","m_27b3d11aed65b1","You must keep at least one Super Admin.") ?? "You must keep at least one Super Admin."), false);
                return;
              }

              let permItems;
              if (next === 'custom') {
                permItems = effectiveOrLocalPermsForUser(uNow, userId);
                usersState.itemsById[userId] = Object.assign({}, permItems);
              } else {
                permItems = clonedLevelPerms(next);
                usersState.itemsById[userId] = Object.assign({}, permItems);
              }

              saveInFlight = true;
              setPermControlsDisabled(tr, true);
              const changedSelf = normEmail(uNow) === ME_EMAIL;
              try{
                const ret = await userSetPerms({ userId, permLevel: next, permItems });
                if (!ret.ok){
                showToast((globalThis.PlatformLanguage?.text("settings","m_ec71d30ae4424e","Update failed") ?? "Update failed"), ret.error || '-', false);
                  return;
                }
                if (changedSelf){
                  try{ await window.Portal?.credits?.refreshCredits?.(); }catch(e){}
                  showToast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"), (globalThis.PlatformLanguage?.text("settings","m_c943c22310dd65","Your permissions changed. Reloading settings...") ?? "Your permissions changed. Reloading settings..."), true);
                  setTimeout(()=>window.location.reload(), 120);
                  return;
                }
                showToast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"), (globalThis.PlatformLanguage?.text("settings","m_588d47403094df","Permission level updated.") ?? "Permission level updated."), true);
                refreshUsers();
              }catch(err){
                showToast((globalThis.PlatformLanguage?.text("settings","m_ec71d30ae4424e","Update failed") ?? "Update failed"), err?.message || 'Unexpected error.', false);
              }finally{
                saveInFlight = false;
                setPermControlsDisabled(tr, false);
              }
            });
          });
          permBtns.forEach(btn=>{
            btn.addEventListener('click', async ()=>{
              if (saveInFlight) return;
              const uNow = usersState.list.find(x => String(x?.id || '') === String(userId));
              if (!uNow) return;
              const levelNow = normLevel(uNow) || 'viewer';
              if (isLastSuper) return;
              const key = btn.getAttribute('data-perm');
              if (!key) return;

              // If not already custom, seed items from effective permissions and switch to custom
              let items;
              if (levelNow !== 'custom') {
                const eff = effectivePerms(uNow);
                items = {};
                for (const pm of PERM_META) {
                  items[pm.k] = !!(eff['*'] || eff[pm.k]);
                }
                usersState.itemsById[userId] = items;
              } else {
                items = Object.assign({}, usersState.itemsById[userId] || asBoolMap(uNow?.org_permissions?.items || {}));
              }

              // Toggle the clicked permission
              items[key] = !items[key];
              usersState.itemsById[userId] = items;
              btn.classList.toggle('on', !!items[key]);
              btn.classList.toggle('off', !items[key]);

              roleBtns.forEach(x => {
                x.classList.toggle('active', x.getAttribute('data-role') === 'custom');
              });

              const changedSelf = normEmail(uNow) === ME_EMAIL;
              saveInFlight = true;
              setPermControlsDisabled(tr, true);
              try{
                const ret = await userSetPerms({ userId, permLevel: 'custom', permItems: items });
              if (!ret.ok){
                items[key] = !items[key];
                usersState.itemsById[userId] = items;
                btn.classList.toggle('on', !!items[key]);
                btn.classList.toggle('off', !items[key]);
                showToast((globalThis.PlatformLanguage?.text("settings","m_c8b7bd7ca69f49","Save failed") ?? "Save failed"), ret.error || '-', false);
                  return;
                }
                if (changedSelf){
                  try{ await window.Portal?.credits?.refreshCredits?.(); }catch(e){}
                  showToast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"), (globalThis.PlatformLanguage?.text("settings","m_c943c22310dd65","Your permissions changed. Reloading settings...") ?? "Your permissions changed. Reloading settings..."), true);
                  setTimeout(()=>window.location.reload(), 120);
                  return;
                }
                showToast((globalThis.PlatformLanguage?.text("settings","m_4bb4688766e904","Saved") ?? "Saved"), (globalThis.PlatformLanguage?.text("settings","m_fbec08b6d49bbc","Permissions updated.") ?? "Permissions updated."), true);
                refreshUsers();
              }catch(err){
                items[key] = !items[key];
                usersState.itemsById[userId] = items;
                btn.classList.toggle('on', !!items[key]);
                btn.classList.toggle('off', !items[key]);
                showToast((globalThis.PlatformLanguage?.text("settings","m_c8b7bd7ca69f49","Save failed") ?? "Save failed"), err?.message || 'Unexpected error.', false);
              }finally{
                saveInFlight = false;
                setPermControlsDisabled(tr, false);
              }
            });
          });
        });
      }
    }
    async function refreshUsers(){
      if (!paneUsers) return;
      const requestSeq = ++usersRefreshSeq;
      closeFloatingMenu();
      const tableEl = paneUsers.querySelector('.fmu-table');
      let prevH = 0;
      if (tableEl) {
        prevH = Math.round(tableEl.getBoundingClientRect().height || 0);
        if (prevH > 0) tableEl.style.minHeight = prevH + 'px';
        tableEl.style.transition = 'opacity .12s ease';
      }
      const r = await usersList();
      if (requestSeq !== usersRefreshSeq) return;
      if (!r.ok){
        const msgEl = getUsersMsgEl();
        usersState.list = [];
        usersState.itemsById = {};
        usersState.superAdmins = [];
        renderUsersTable();
        if (msgEl) msgEl.textContent = r.error ? `Could not load users: ${r.error}` : 'Could not load users.';
        if (tableEl) tableEl.style.opacity = '1';
        if (tableEl) tableEl.style.minHeight = '';
        showToast((globalThis.PlatformLanguage?.text("settings","m_132a6fe97f9139","Users unavailable") ?? "Users unavailable"), r.error || '-', false);
        return;
      }
      const list = (r.users || []);
      const itemsById = Object.assign({}, usersState.itemsById || {});
      for (const u of list){
        const id = String(u?.id || '');
        if (!id) continue;
        if (!itemsById[id]) itemsById[id] = asBoolMap(u?.org_permissions?.items || {});
      }
      usersState.list = list;
      usersState.itemsById = itemsById;
      usersState.superAdmins = computeSuperAdmins(list);
      try{
        renderUsersTable();
        syncUsersPermissionsUi();
      }catch(err){
        const msgEl = getUsersMsgEl();
        if (msgEl) msgEl.textContent = ((v0) => globalThis.PlatformLanguage?.text("settings","m_315a57101fd8ce",`Could not render users: ${v0}`,{v0}) ?? `Could not render users: ${v0}`)(err?.message || 'Unknown error');
        if (tableEl) tableEl.style.opacity = '1';
        requestAnimationFrame(()=>{ if (tableEl) tableEl.style.minHeight = ''; });
        showToast((globalThis.PlatformLanguage?.text("settings","m_0730f808713d52","Users render failed") ?? "Users render failed"), err?.message || 'Unknown error', false);
        return;
      }
      if (tableEl) tableEl.style.opacity = '1';
      requestAnimationFrame(()=>{ if (tableEl) tableEl.style.minHeight = ''; });
    }
    if(paneUsers) {
      const rBtn = $('#cuReload', paneUsers);
      if(rBtn) rBtn.addEventListener('click', refreshUsers);
      const pBtn = $('#cuPerms', paneUsers);
      if (pBtn) {
        pBtn.addEventListener('click', ()=>{
          usersState.showPerms = !usersState.showPerms;
          syncUsersPermissionsUi();
        });
      }
    }
    if (canUsers && canAddDelete && paneUsers) {
      const addBtn = $('#cuAdd', paneUsers);
      if(addBtn) {
        addBtn.addEventListener('click', ()=>{
          const inviteState = {
            level: 'viewer',
            perms: clonedLevelPerms('viewer')
          };
          const avatarState = {
            file: null,
            previewUrl: ''
          };
          const m = modal({
            title: (globalThis.PlatformLanguage?.text("settings","m_c2a90c9c15d89f","Add user") ?? "Add user"),
            subtitle: (globalThis.PlatformLanguage?.text("settings","m_73bd248a3c7c74","They will receive a welcome email with an activation link.") ?? "They will receive a welcome email with an activation link."),
            bodyHtml: `
              <div class="fmu-rows">
                <div class="fmu-newAvatarRow">
                  <div class="fmu-newAvatarWrap">
                    <button class="fmu-userAvatar" type="button" id="cuNewAvatarBtn" data-fm-tooltip="Choose profile picture">
                      <span id="cuNewAvatarInitial">?</span>
                      <span class="fmu-userAvatarEdit"><i class="fas fa-camera"></i></span>
                    </button>
                    <input class="fmu-fileInput" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" id="cuNewAvatarFile">
                    <div class="fmu-newAvatarNote">Optional profile picture</div>
                  </div>
                </div>
                <div class="fmu-row">
                  <div class="fmu-lbl">Name</div>
                  <input class="fmu-shared-in" id="cuNewName" placeholder="Jane Doe" autocomplete="off">
                </div>
                <div class="fmu-row">
                  <div class="fmu-lbl">Email</div>
                  <input class="fmu-shared-in" id="cuNewEmail" placeholder="jane.doe@company.com" autocomplete="off" inputmode="email">
                </div>
                <div class="fmu-row">
                  <div class="fmu-lbl">Permission level</div>
                  <div class="fmu-rolePresets" id="cuNewRolePresets">
                    ${renderRolePresetButtons(inviteState.level, false)}
                  </div>
                  <div class="fmu-permHint" id="cuNewPermHint">${permissionHintText(inviteState.level, true)}</div>
                  <div class="fmu-permGrid" id="cuNewPermGrid">
                    <div class="fmu-permLabel">Permissions</div>
                    ${renderPermissionButtons(effectivePermsForLevel(inviteState.level, inviteState.perms), false)}
                  </div>
                </div>
              </div>
              <div class="fmu-shared-note" id="cuNewStatus" style="margin-top:10px;"></div>
            `
          });
          const footer = document.createElement('div');
          footer.className = 'fmu-mactions';
          footer.innerHTML = `
            <button class="fmu-shared-btn ghost" type="button"><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_842e54dc81e3fa"," Cancel") ?? " Cancel")}</button>
            <button class="fmu-shared-btn primary" type="button"><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_45e3a1c4c7599a"," Send invite") ?? " Send invite")}</button>
          `;
          m.el.querySelector('.fmu-modal').appendChild(footer);
          const elName = m.el.querySelector('#cuNewName');
          const elEmail = m.el.querySelector('#cuNewEmail');
          const elStatus = m.el.querySelector('#cuNewStatus');
          const elRolePresets = m.el.querySelector('#cuNewRolePresets');
          const elPermGrid = m.el.querySelector('#cuNewPermGrid');
          const elPermHint = m.el.querySelector('#cuNewPermHint');
          const elAvatarBtn = m.el.querySelector('#cuNewAvatarBtn');
          const elAvatarFile = m.el.querySelector('#cuNewAvatarFile');
          const elAvatarInitial = m.el.querySelector('#cuNewAvatarInitial');
          const [btnCancel, btnSend] = footer.querySelectorAll('button');
          function refreshInviteAvatarUi(){
            const fallback = userInitial(elName?.value || '', elEmail?.value || '');
            if (elAvatarInitial) elAvatarInitial.textContent = fallback;
            if (!elAvatarBtn) return;
            if (avatarState.previewUrl){
              elAvatarBtn.innerHTML = `<img src="${String(escapeHtml(avatarState.previewUrl))}" alt="${(globalThis.PlatformLanguage?.htmlText("settings","m_01681f36aa7ae4","Profile picture") ?? "Profile picture")}"><span class="fmu-userAvatarEdit"><i class="fas fa-camera"></i></span>`;
            } else {
              elAvatarBtn.innerHTML = `<span id="cuNewAvatarInitial">${escapeHtml(fallback)}</span><span class="fmu-userAvatarEdit"><i class="fas fa-camera"></i></span>`;
            }
          }
          function refreshInvitePermUi(){
            if (elRolePresets) elRolePresets.innerHTML = renderRolePresetButtons(inviteState.level, false);
            if (elPermHint) elPermHint.textContent = permissionHintText(inviteState.level, true);
            if (elPermGrid) {
              elPermGrid.innerHTML = `<div class="fmu-permLabel">${(globalThis.PlatformLanguage?.htmlText("settings","m_0ded144729a113","Permissions") ?? "Permissions")}</div>${String(renderPermissionButtons(effectivePermsForLevel(inviteState.level, inviteState.perms), false))}`;
            }
            elRolePresets?.querySelectorAll('button[data-role]').forEach(btn=>{
              btn.addEventListener('click', ()=>{
                const next = String(btn.getAttribute('data-role') || 'viewer').toLowerCase().trim();
                inviteState.level = next;
                if (next !== 'custom') inviteState.perms = clonedLevelPerms(next);
                refreshInvitePermUi();
              });
            });
            elPermGrid?.querySelectorAll('button[data-perm]').forEach(btn=>{
              btn.addEventListener('click', ()=>{
                const key = String(btn.getAttribute('data-perm') || '').trim();
                if (!key) return;
                if (inviteState.level !== 'custom') {
                  inviteState.perms = effectivePermsForLevel(inviteState.level, inviteState.perms);
                  inviteState.level = 'custom';
                }
                inviteState.perms[key] = !inviteState.perms[key];
                refreshInvitePermUi();
              });
            });
          }
          elAvatarBtn?.addEventListener('click', ()=>{
            elAvatarFile.value = '';
            elAvatarFile.click();
          });
          elAvatarFile?.addEventListener('change', ()=>{
            const file = elAvatarFile.files && elAvatarFile.files[0];
            if (!file) return;
            if (avatarState.previewUrl && avatarState.previewUrl.startsWith('blob:')) {
              try{ URL.revokeObjectURL(avatarState.previewUrl); }catch(e){}
            }
            avatarState.file = file;
            avatarState.previewUrl = URL.createObjectURL(file);
            refreshInviteAvatarUi();
          });
          elName?.addEventListener('input', refreshInviteAvatarUi);
          elEmail?.addEventListener('input', refreshInviteAvatarUi);
          refreshInviteAvatarUi();
          refreshInvitePermUi();
          btnCancel.addEventListener('click', ()=>m.close());
          btnSend.addEventListener('click', async ()=>{
            const name = String(elName.value || '').trim();
            const email = String(elEmail.value || '').trim().toLowerCase();
            const level = String(inviteState.level || 'viewer').trim().toLowerCase();
            if (!email || !email.includes('@')){
              showToast((globalThis.PlatformLanguage?.text("settings","m_3d139aa9918a1e","Missing email") ?? "Missing email"), (globalThis.PlatformLanguage?.text("settings","m_966872f2233bc5","Please enter a valid email.") ?? "Please enter a valid email."), false);
              return;
            }
            elStatus.textContent = (globalThis.PlatformLanguage?.text("settings","m_1d79550e2c3d65","Creating user + sending email...") ?? "Creating user + sending email...");
            btnSend.disabled = true;
            const ret = await userAdd({
              email,
              name,
              permLevel: level,
              permItems: level === 'custom' ? inviteState.perms : {}
            });
            btnSend.disabled = false;
            if (!ret.ok){
              elStatus.textContent = '';
              showToast((globalThis.PlatformLanguage?.text("settings","m_88586c062e2d41","Invite failed") ?? "Invite failed"), ret.error || '-', false);
              return;
            }
            if (avatarState.file && ret.user?.id){
              elStatus.textContent = (globalThis.PlatformLanguage?.text("settings","m_81ff8eabf534d7","Saving profile picture...") ?? "Saving profile picture...");
              const avatarRet = await uploadUserAvatar({ userId: ret.user.id, file: avatarState.file });
              if (!avatarRet.ok){
                elStatus.textContent = '';
                showToast((globalThis.PlatformLanguage?.text("settings","m_7e87896e6d2524","User added") ?? "User added"), (globalThis.PlatformLanguage?.text("settings","m_6e9bec1707a6f2","Invite sent, but the profile picture could not be saved.") ?? "Invite sent, but the profile picture could not be saved."), true);
                m.close();
                refreshUsers();
                if (!ret.emailed && ret.activate_url){
                  try{ navigator.clipboard.writeText(ret.activate_url); }catch(e){}
                }
                return;
              }
            }
            elStatus.textContent = '';
            if (avatarState.previewUrl && avatarState.previewUrl.startsWith('blob:')) {
              try{ URL.revokeObjectURL(avatarState.previewUrl); }catch(e){}
            }
            m.close();
            const msg = ret.emailed ? 'Invite email sent.' : 'User created, but email failed to send.';
            showToast((globalThis.PlatformLanguage?.text("settings","m_7e87896e6d2524","User added") ?? "User added"), msg, true);
            refreshUsers();
            if (!ret.emailed && ret.activate_url){
              try{ navigator.clipboard.writeText(ret.activate_url); }catch(e){}
            }
          });
        });
      }
    }

    return { refresh: refreshUsers, destroy() { for (const close of openModals) close(); lifecycle.abort(); closeFloatingMenu(); floatingMenu?.remove(); usersRefreshSeq++; } };
  } };
})();
