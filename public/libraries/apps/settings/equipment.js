/* public/libraries/apps/settings/equipment.js
 * Equipment module settings — one shared renderer used by (a) the company
 * settings Equipment tab and (b) the Equipment app's Settings view. Leads with
 * the complexity dial (Simple / Standard / Advanced tier presets that write
 * equipment feature flags), then exposes the individual feature flags and the
 * behavioral knobs stored in the equipment module settings. App enablement is
 * deliberately owned by Features & Apps rather than this complexity dial.
 */
(function(root){
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  const FEATURES = [
    { key:'equipment.scheduling', icon:'fa-calendar-days', label:(globalThis.PlatformLanguage?.text("settings","m_4249990706c50e","Scheduling") ?? "Scheduling"), hint:'Assign equipment to schedule events, generate scope equipment events, and surface conflicts.' },
    { key:'equipment.requirements', icon:'fa-list-check', label:(globalThis.PlatformLanguage?.text("settings","m_b7207716fa6bb0","Requirements") ?? "Requirements"), hint:'Scopes declare equipment requirements by type; scheduling fulfills them with concrete units.' },
    { key:'equipment.maintenance', icon:'fa-wrench', label:(globalThis.PlatformLanguage?.text("settings","m_4dd0d4a2b7cda6","Maintenance") ?? "Maintenance"), hint:'Service programs, work orders, inspections, and downtime blocks.' },
    { key:'equipment.meters', icon:'fa-gauge-high', label:(globalThis.PlatformLanguage?.text("settings","m_d9111dc5e9c599","Meters") ?? "Meters"), hint:'Hour and mileage readings, fuel entries, and meter-based service intervals.' },
    { key:'equipment.operators', icon:'fa-id-card', label:(globalThis.PlatformLanguage?.text("settings","m_62237803819453","Operator Requirements") ?? "Operator Requirements"), hint:'Certification checks (CDL, certified operator) when equipment is assigned.' },
    { key:'equipment.costing', icon:'fa-dollar-sign', label:(globalThis.PlatformLanguage?.text("settings","m_809e39905f5b4a","Costing") ?? "Costing"), hint:'Rates, projected and actual equipment costs on projects, and utilization reporting.' },
    { key:'equipment.custody', icon:'fa-qrcode', label:(globalThis.PlatformLanguage?.text("settings","m_17860073665540","Custody Tracking") ?? "Custody Tracking"), hint:'Check-out / check-in tracking and printable unit QR labels.' }
  ];

  const TIERS = [
    {
      id:'simple', label:(globalThis.PlatformLanguage?.text("settings","m_1ebe39fb49273a","Simple") ?? "Simple"), icon:'fa-truck-pickup',
      hint:'"The truck is on the job." The Equipment tab plus scheduling with conflict warnings and single-unit auto-fulfill.',
      capabilities:{
        'equipment.scheduling':true, 'equipment.requirements':false,
        'equipment.maintenance':false, 'equipment.meters':false, 'equipment.operators':false,
        'equipment.costing':false, 'equipment.custody':false
      },
      settings:{ tier:'simple', conflict_mode:'warn', auto_fulfill_single_unit:true }
    },
    {
      id:'standard', label:(globalThis.PlatformLanguage?.text("settings","m_00f3e8b60aebc9","Standard") ?? "Standard"), icon:'fa-truck-ramp-box',
      hint:'The typical contractor: requirements, maintenance work orders, and costing, with hard conflict blocking.',
      capabilities:{
        'equipment.scheduling':true, 'equipment.requirements':true,
        'equipment.maintenance':true, 'equipment.meters':false, 'equipment.operators':false,
        'equipment.costing':true, 'equipment.custody':false
      },
      settings:{ tier:'standard', conflict_mode:'block', auto_fulfill_single_unit:true }
    },
    {
      id:'advanced', label:(globalThis.PlatformLanguage?.text("settings","m_d2b9e528c379c3","Advanced") ?? "Advanced"), icon:'fa-truck-monster',
      hint:'Heavy equipment / enterprise: meters, operator enforcement, custody tracking, everything on.',
      capabilities:{
        'equipment.scheduling':true, 'equipment.requirements':true,
        'equipment.maintenance':true, 'equipment.meters':true, 'equipment.operators':true,
        'equipment.costing':true, 'equipment.custody':true
      },
      settings:{ tier:'advanced', conflict_mode:'block', operator_enforcement:'block', field_meter_entry:true }
    }
  ];

  const KNOBS = [
    { key:'conflict_mode', kind:'select', label:(globalThis.PlatformLanguage?.text("settings","m_d662cefe8a053c","Double-booking conflicts") ?? "Double-booking conflicts"), hint:'What happens when a unit is booked on two overlapping events.', options:[['warn','Warn but allow'],['block','Block the booking'],['off','Ignore conflicts']] },
    { key:'auto_fulfill_single_unit', kind:'toggle', label:(globalThis.PlatformLanguage?.text("settings","m_4d57553e34180e","Auto-fulfill single-unit types") ?? "Auto-fulfill single-unit types"), hint:'When a required type has exactly one active unit, assign it automatically.' },
    { key:'default_meter_units', kind:'select', label:(globalThis.PlatformLanguage?.text("settings","m_4536f91f4e518d","Default meter units") ?? "Default meter units"), hint:'The meter kind new equipment types start with.', options:[['hours','Hours'],['miles','Miles'],['both','Hours and miles']], requires:'equipment.meters' },
    { key:'downtime_auto_block', kind:'toggle', label:(globalThis.PlatformLanguage?.text("settings","m_89eb1713be4c51","Downtime blocks the schedule") ?? "Downtime blocks the schedule"), hint:'Scheduled work orders create downtime blocks that participate in conflict detection.', requires:'equipment.maintenance' },
    { key:'operator_enforcement', kind:'select', label:(globalThis.PlatformLanguage?.text("settings","m_807b11c8bd1c77","Operator requirements") ?? "Operator requirements"), hint:'Whether missing operator certifications warn or block the assignment.', options:[['warn','Warn but allow'],['block','Block the assignment']], requires:'equipment.operators' },
    { key:'field_meter_entry', kind:'toggle', label:(globalThis.PlatformLanguage?.text("settings","m_c0783ae70fd82f","Field meter entry") ?? "Field meter entry"), hint:'Crews can log meter readings from the field app on assigned events.', requires:'equipment.meters' }
  ];

  function injectCss(){
    if (document.getElementById('fmEquipmentSettingsCss')) return;
    const style = document.createElement('style');
    style.id = 'fmEquipmentSettingsCss';
    style.textContent = `
      .eqs-root{color:#17212b;min-height:420px}.eqs-root *{box-sizing:border-box}
      .eqs-loading{display:grid;place-items:center;min-height:320px;color:#667085;font-size:12px;font-weight:850}
      .eqs-error{border:1px solid #fecdca;border-radius:10px;background:#fef3f2;padding:14px;color:#b42318;font-size:12px;font-weight:800}
      .eqs-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
      .eqs-head-copy h3{margin:0;font-size:24px;line-height:1.15;letter-spacing:-.02em;display:flex;align-items:center;gap:11px}
      .eqs-head-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;font-size:16px;flex:0 0 auto}
      .eqs-head-copy p{margin:7px 0 0;color:#667085;font-size:12.5px;line-height:1.5;max-width:620px}
      .eqs-section{margin-top:20px}
      .eqs-section > h4{margin:0 0 4px;font-size:13.5px;color:#101828;display:flex;align-items:center;gap:8px}
      .eqs-section > h4 i{color:var(--primary-readable,var(--primary,#d93025));font-size:12px}
      .eqs-section > p{margin:0 0 12px;color:#667085;font-size:11.5px;line-height:1.5;font-weight:650}
      .eqs-tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
      .eqs-tier{border:1.5px solid #e4e7ec;border-radius:14px;background:#fff;padding:14px;text-align:left;cursor:pointer;font:inherit;color:inherit;display:grid;gap:7px;transition:border-color .12s ease,box-shadow .12s ease}
      .eqs-tier:hover{border-color:#c8cfda}
      .eqs-tier.on{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.10)}
      .eqs-tier-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .eqs-tier-top strong{font-size:13.5px;display:flex;align-items:center;gap:8px}
      .eqs-tier-top strong i{color:var(--primary-readable,var(--primary,#d93025));font-size:13px}
      .eqs-tier-check{width:18px;height:18px;border-radius:999px;border:1.5px solid #d0d5dd;display:grid;place-items:center;font-size:9px;color:#fff;flex:0 0 auto}
      .eqs-tier.on .eqs-tier-check{background:var(--primary-readable,var(--primary,#d93025));border-color:transparent}
      .eqs-tier>span{color:#667085;font-size:11px;line-height:1.5;font-weight:650}
      .eqs-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
      .eqs-row{border:1px solid #e4e7ec;border-radius:12px;background:#fff;padding:12px 14px;display:flex;align-items:flex-start;gap:12px}
      .eqs-row.off-dep{opacity:.55}
      .eqs-row-icon{width:32px;height:32px;border-radius:9px;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));display:grid;place-items:center;font-size:13px;flex:0 0 auto;margin-top:2px}
      .eqs-row-copy{flex:1;min-width:0}
      .eqs-row-copy strong{display:block;font-size:12.5px;color:#101828}
      .eqs-row-copy span{display:block;margin-top:3px;color:#667085;font-size:11px;line-height:1.45;font-weight:650}
      .eqs-row-copy .dep-note{color:#b54708;font-weight:750}
      .eqs-switch{position:relative;display:inline-block;width:42px;height:24px;flex:0 0 auto;margin-top:5px}
      .eqs-switch input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;margin:0;z-index:2}
      .eqs-switch .track{position:absolute;inset:0;border-radius:999px;background:#d5dbe3;transition:background .16s ease}
      .eqs-switch .track::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.25);transition:transform .16s ease}
      .eqs-switch input:checked + .track{background:var(--primary-readable,var(--primary,#d93025))}
      .eqs-switch input:checked + .track::after{transform:translateX(18px)}
      .eqs-switch input:disabled{cursor:not-allowed}
      .eqs-select{border:1px solid #d0d5dd;border-radius:9px;background:#fff;padding:8px 10px;color:#344054;font:750 12px/1.2 inherit;outline:0;margin-top:2px}
      .eqs-select:focus{border-color:var(--primary-readable,var(--primary,#d93025))}
      .eqs-select:disabled{background:#f4f6f9;color:#98a2b3;cursor:not-allowed}
      .eqs-foot{margin-top:18px;display:flex;align-items:center;gap:12px}
      .eqs-save{appearance:none;border:0;border-radius:10px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;padding:11px 20px;font:900 12.5px/1 inherit;cursor:pointer}
      .eqs-save:disabled{opacity:.5;cursor:not-allowed}
      .eqs-dirty{color:#667085;font-size:11px;font-weight:750}
    `;
    document.head.appendChild(style);
  }

  function mount(rootEl, context = {}){
    if (!rootEl) return { destroy(){} };
    injectCss();
    const orgId = String(context.orgId ?? '').trim();
    const toast = typeof context.showToast === 'function' ? context.showToast : () => {};
    const terminology = (key, fallback) => root.PlatformTerminology?.get?.(key, fallback) || fallback;
    const state = {
      loading:true,
      error:'',
      capabilities:null,
      settings:null,
      revision:0,
      saved:'',
      saving:false,
      applyingTier:''
    };
    let destroyed = false;
    rootEl.innerHTML = `<div class="eqs-root"><div class="eqs-loading">${(globalThis.PlatformLanguage?.htmlText("settings","m_d3dc2d47bdb9f2","Loading equipment settings…") ?? "Loading equipment settings…")}</div></div>`;

    const capValue = (key) => {
      const raw = object(state.capabilities?.raw);
      const definition = state.capabilities?.definitions_by_key?.[key];
      return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] !== false : definition?.default !== false;
    };
    const capEffective = (key) => state.capabilities?.effective_by_key?.[key] === true;

    function activeTierId(){
      const stored = String(state.settings?.tier || '').trim();
      if (!capValue('apps.equipment')) return 'custom';
      if (['simple','standard','advanced'].includes(stored)) {
        const tier = TIERS.find((entry) => entry.id === stored);
        const matches = tier && Object.entries(tier.capabilities).every(([key, expected]) => capValue(key) === expected);
        if (matches) return stored;
      }
      return 'custom';
    }

    function isDirty(){
      return JSON.stringify(state.settings) !== state.saved;
    }

    async function load(){
      try {
        const [capabilities, settingsResult] = await Promise.all([
          root.PlatformAPI?.capabilities?.load?.(orgId, { refresh:true }),
          root.EquipmentAPI.settings(orgId).catch((error) => {
            /* App enablement is managed separately in Features & Apps. Keep
             * this renderer resilient if that flag changes while it is open. */
            if (error?.status === 403) return { settings:null, revision:0 };
            throw error;
          })
        ]);
        if (destroyed) return;
        state.capabilities = capabilities;
        state.settings = settingsResult.settings ? object(settingsResult.settings) : null;
        state.revision = Number(settingsResult.revision || 0);
        state.saved = JSON.stringify(state.settings);
        state.loading = false;
        render();
      } catch (error) {
        if (destroyed) return;
        state.loading = false;
        state.error = error?.message || 'Equipment settings could not be loaded.';
        render();
      }
    }

    async function applyTier(tierId){
      const tier = TIERS.find((entry) => entry.id === tierId);
      if (!tier || state.applyingTier) return;
      state.applyingTier = tierId;
      render();
      try {
        /* Refresh the revision before writing the behavioral half of the
         * preset. This keeps a stale settings pane from preventing a tier
         * transition, while the single capability update changes every
         * dependent feature flag together. */
        const current = await root.EquipmentAPI.settings(orgId);
        const saved = await root.EquipmentAPI.saveSettings(orgId, {
          ...tier.settings,
          expected_revision:Number(current.revision || 0) || undefined
        });
        state.settings = object(saved.settings);
        state.revision = Number(saved.revision || 0);
        state.saved = JSON.stringify(state.settings);
        state.capabilities = await root.PlatformAPI.capabilities.update(orgId, tier.capabilities);
        toast((globalThis.PlatformLanguage?.text("settings","m_2813f320a63b94","Equipment") ?? "Equipment"), ((v0) => globalThis.PlatformLanguage?.text("settings","m_6f22a89bcb8b2f",`The ${v0} tier is applied. Individual flags stay adjustable below.`,{v0}) ?? `The ${v0} tier is applied. Individual flags stay adjustable below.`)(tier.label), true);
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("settings","m_2813f320a63b94","Equipment") ?? "Equipment"), error?.message || 'The tier could not be applied.', false);
      } finally {
        state.applyingTier = '';
        render();
      }
    }

    async function toggleFeature(key, enabled){
      try {
        state.capabilities = await root.PlatformAPI.capabilities.update(orgId, { [key]: enabled });
        if (state.settings) {
          /* Manual flag edits make the stored tier informational only. */
          const saved = await root.EquipmentAPI.saveSettings(orgId, { tier:'custom', expected_revision: state.revision || undefined });
          state.settings = object(saved.settings);
          state.revision = Number(saved.revision || 0);
          state.saved = JSON.stringify(state.settings);
        }
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("settings","m_2813f320a63b94","Equipment") ?? "Equipment"), error?.message || 'The flag could not be changed.', false);
      }
      render();
    }

    async function save(){
      if (state.saving || !isDirty() || !state.settings) return;
      state.saving = true;
      render();
      try {
        const saved = await root.EquipmentAPI.saveSettings(orgId, { ...state.settings, expected_revision: state.revision || undefined });
        state.settings = object(saved.settings);
        state.revision = Number(saved.revision || 0);
        state.saved = JSON.stringify(state.settings);
        toast((globalThis.PlatformLanguage?.text("settings","m_2813f320a63b94","Equipment") ?? "Equipment"), (globalThis.PlatformLanguage?.text("settings","m_714e3a5c86ba47","Equipment settings saved.") ?? "Equipment settings saved."), true);
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("settings","m_2813f320a63b94","Equipment") ?? "Equipment"), error?.message || 'Could not save equipment settings.', false);
      } finally {
        state.saving = false;
        render();
      }
    }

    function render(){
      if (destroyed) return;
      if (state.loading) return;
      if (state.error) {
        rootEl.innerHTML = `<div class="eqs-root"><div class="eqs-error">${esc(state.error)}</div></div>`;
        return;
      }
      const appOn = capValue('apps.equipment');
      const tierId = activeTierId();
      const unitLabel = terminology('equipment.portal_tab', 'Equipment');
      let html = `
        <div class="eqs-root">
          <div class="eqs-head">
            <div class="eqs-head-copy">
              <h3><span class="eqs-head-icon"><i class="fas fa-truck-pickup"></i></span> ${String(esc(unitLabel))}</h3>
              <p>${(globalThis.PlatformLanguage?.htmlText("settings","m_c892762483d21c","One equipment system, dialed by capability. Pick the tier that fits how you run equipment — every flag stays individually adjustable afterwards.") ?? "One equipment system, dialed by capability. Pick the tier that fits how you run equipment — every flag stays individually adjustable afterwards.")}</p>
            </div>
          </div>
          <div class="eqs-section">
            <h4><i class="fas fa-sliders"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_1b9d193d4f15f6"," How much equipment management do you need?") ?? " How much equipment management do you need?")}</h4>
            <p>${(globalThis.PlatformLanguage?.htmlText("settings","m_cb067584c0c610","The tier writes the feature flags below. It is a preset, not a mode.") ?? "The tier writes the feature flags below. It is a preset, not a mode.")}</p>
            <div class="eqs-tiers">
              ${String(TIERS.map((tier) => `
                <button type="button" class="eqs-tier ${tierId === tier.id ? 'on' : ''}" data-eqs-tier="${esc(tier.id)}" ${state.applyingTier ? 'disabled' : ''}>
                  <div class="eqs-tier-top">
                    <strong><i class="fas ${esc(tier.icon)}"></i> ${esc(tier.label)}</strong>
                    <span class="eqs-tier-check">${tierId === tier.id ? '<i class="fas fa-check"></i>' : ''}</span>
                  </div>
                  <span>${esc(tier.hint)}</span>
                </button>
              `).join(''))}
            </div>
          </div>`;
      if (appOn) {
        html += `
          <div class="eqs-section">
            <h4><i class="fas fa-toggle-on"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_5539ab93aa7a52"," Features") ?? " Features")}</h4>
            <p>${(globalThis.PlatformLanguage?.htmlText("settings","m_5ba59ed73657bf","The layers of the equipment system. Off layers hide completely — views, fields, and money included.") ?? "The layers of the equipment system. Off layers hide completely — views, fields, and money included.")}</p>
            <div class="eqs-cards">
              ${String(FEATURES.map((feature) => {
                const definition = state.capabilities?.definitions_by_key?.[feature.key];
                const parentKey = String(definition?.parent || 'apps.equipment');
                const parentOn = parentKey === 'apps.equipment' ? appOn : capEffective(parentKey);
                const parentLabel = state.capabilities?.definitions_by_key?.[parentKey]?.label || parentKey;
                return `
                  <div class="eqs-row ${parentOn ? '' : 'off-dep'}">
                    <span class="eqs-row-icon"><i class="fas ${esc(feature.icon)}"></i></span>
                    <div class="eqs-row-copy">
                      <strong>${esc(feature.label)}</strong>
                      <span>${esc(feature.hint)}</span>
                      ${parentOn ? '' : `<span class="dep-note">${((v0) => globalThis.PlatformLanguage?.htmlText("settings","m_eb768df1328610",`Needs ${v0}.`,{v0}) ?? `Needs ${v0}.`)(esc(parentLabel))}</span>`}
                    </div>
                    <label class="eqs-switch">
                      <input type="checkbox" data-eqs-feature="${esc(feature.key)}" ${capValue(feature.key) ? 'checked' : ''} ${parentOn ? '' : 'disabled'}>
                      <span class="track"></span>
                    </label>
                  </div>`;
              }).join(''))}
            </div>
          </div>`;
        if (state.settings) {
          html += `
          <div class="eqs-section">
            <h4><i class="fas fa-gear"></i>${(globalThis.PlatformLanguage?.htmlText("settings","m_f7a333522c8ac0"," Behavior") ?? " Behavior")}</h4>
            <p>${(globalThis.PlatformLanguage?.htmlText("settings","m_81d28f6f255a5c","Knobs that tune how the enabled features act.") ?? "Knobs that tune how the enabled features act.")}</p>
            <div class="eqs-cards">
              ${String(KNOBS.map((knob) => {
                const gated = knob.requires ? !capEffective(knob.requires) : false;
                const value = state.settings[knob.key];
                const control = knob.kind === 'select'
                  ? `<select class="eqs-select" data-eqs-knob="${esc(knob.key)}" ${gated ? 'disabled' : ''}>
                      ${knob.options.map(([optionValue, optionLabel]) => `<option value="${esc(optionValue)}" ${String(value) === optionValue ? 'selected' : ''}>${esc(optionLabel)}</option>`).join('')}
                    </select>`
                  : `<label class="eqs-switch">
                      <input type="checkbox" data-eqs-knob="${esc(knob.key)}" ${value === true ? 'checked' : ''} ${gated ? 'disabled' : ''}>
                      <span class="track"></span>
                    </label>`;
                const gatedLabel = gated ? state.capabilities?.definitions_by_key?.[knob.requires]?.label || knob.requires : '';
                return `
                  <div class="eqs-row ${gated ? 'off-dep' : ''}">
                    <div class="eqs-row-copy">
                      <strong>${esc(knob.label)}</strong>
                      <span>${esc(knob.hint)}</span>
                      ${gated ? `<span class="dep-note">${((v0) => globalThis.PlatformLanguage?.htmlText("settings","m_eb768df1328610",`Needs ${v0}.`,{v0}) ?? `Needs ${v0}.`)(esc(gatedLabel))}</span>` : ''}
                    </div>
                    ${control}
                  </div>`;
              }).join(''))}
            </div>
            <div class="eqs-foot">
              <button type="button" class="eqs-save" data-eqs-save ${String(state.saving || !isDirty() ? 'disabled' : '')}>${String(state.saving ? 'Saving…' : 'Save changes')}</button>
              ${String(isDirty() ? `<span class="eqs-dirty">${(globalThis.PlatformLanguage?.htmlText("settings","m_79d73034c60bb9","Unsaved behavior changes.") ?? "Unsaved behavior changes.")}</span>` : '')}
            </div>
          </div>`;
        }
      }
      html += '</div>';
      rootEl.innerHTML = html;

      rootEl.querySelectorAll('[data-eqs-tier]').forEach((button) => button.addEventListener('click', () => {
        const tier = TIERS.find((entry) => entry.id === button.dataset.eqsTier);
        if (!tier) return;
        void applyTier(tier.id);
      }));
      rootEl.querySelectorAll('[data-eqs-feature]').forEach((input) => input.addEventListener('change', () => {
        void toggleFeature(input.dataset.eqsFeature, input.checked === true);
      }));
      rootEl.querySelectorAll('[data-eqs-knob]').forEach((input) => input.addEventListener('change', () => {
        if (!state.settings) return;
        const key = input.dataset.eqsKnob;
        state.settings = { ...state.settings, [key]: input.type === 'checkbox' ? input.checked === true : String(input.value) };
        render();
      }));
      rootEl.querySelector('[data-eqs-save]')?.addEventListener('click', () => void save());
    }

    void load();
    return {
      refresh(){ return load(); },
      destroy(){ destroyed = true; rootEl.innerHTML = ''; }
    };
  }

  root.FirstMateEquipmentSettings = { mount };
})(window);
