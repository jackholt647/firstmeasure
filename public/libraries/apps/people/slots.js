/* public/libraries/apps/people/slots.js
 *
 * Tab slots: places in the entity modal that another module fills. People
 * declares the slot (which tab, on which kinds of entity); the owning module
 * registers what goes in it. Until it does, the tab shows a quiet placeholder.
 *
 * Declared slots
 *   'compensation'   how this entity is paid          (pay sheets and pay rules own it)
 *   'fields'         this entity's custom fields      (custom fields own it)
 *
 * To fill a slot, from any script loaded with Settings:
 *
 *   FirstMatePeople.slots.register('compensation', {
 *     kinds: ['organization_user', 'access_role'],     // optional; omit to serve every kind the slot is shown for
 *     mount(container, context) {
 *       // context.entity   { kind, id, key, name }    key is "<kind>:<id>", the assignee key for assignees;
 *       //                  also home:{ kind:'role'|'group_type'|'company_type'|'department', id } for a role, a type or a department,
 *       //                  traits (ask these, never the kind) and members:[{ id, name }] for anything with members
 *       // context.orgId, context.branchId
 *       // context.readOnly true when the viewer may not edit this entity
 *       // context.onDirty(isDirty)   tell the modal there are unsaved changes (enables its Save)
 *       // context.onSaved()          tell the modal a save you made yourself finished
 *       return { save: async () => {}, destroy() {} };  // both optional; save() runs from the modal's Save
 *     }
 *   });
 *
 * Entity kinds: 'organization_user', 'resource_group', 'organization_connection'
 * (the three assignee kinds, see docs/architecture/assignees.md), plus
 * 'access_role', 'resource_group_kind' and 'department' for the things that
 * hold defaults for them.
 *
 * People side:  FirstMatePeople.slots.tab('compensation', entity, { readOnly })  returns a tab
 * definition for entityModal.open({ tabs }).
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.slots) return;
  const kit = People.kit;
  const { esc, t } = kit;
  const providers = new Map();
  const waiting = new Set();

  const DECLARED = {
    compensation:{ label:() => t('compensation', 'Compensation'), icon:kit.ICONS.compensation },
    fields:{ label:() => t('fields', 'Fields'), icon:kit.ICONS.fields }
  };

  function ensureStyles(){
    if (document.getElementById('pp_slot_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_slot_css';
    style.textContent = `
      .pp-slot{height:100%;min-height:0}
      .pp-slot-empty{display:grid;place-content:center;justify-items:center;gap:12px;height:100%;min-height:220px;border:1px dashed var(--pp-line);border-radius:14px;background:repeating-linear-gradient(135deg,transparent 0 11px,rgba(16,24,40,.018) 11px 22px);text-align:center}
      .pp-slot-empty>i{display:grid;place-items:center;width:52px;height:52px;border-radius:14px;background:var(--pp-panel);border:1px solid var(--pp-line);color:var(--pp-faint);font-size:19px;box-shadow:0 1px 2px rgba(16,24,40,.05)}
      .pp-slot-empty>strong{color:var(--pp-strong);font-size:14px;font-weight:650}
    `;
    document.head.appendChild(style);
  }
  function providerFor(slotId, entity){
    return (providers.get(slotId) || []).find((provider) => !provider.kinds || provider.kinds.includes(entity?.kind)) || null;
  }
  function placeholder(container, slotId){
    const slot = DECLARED[slotId] || { label:() => slotId, icon:'fa-puzzle-piece' };
    container.innerHTML = `<div class="pp-slot-empty" data-people-slot-empty="${esc(slotId)}"><i class="fas ${esc(slot.icon)}" aria-hidden="true"></i><strong>${esc(slot.label())}</strong>${kit.pill({ label:t('coming_next', 'Coming next'), tone:'role', tooltip:t('slot_tip', 'This tab is filled in by the module that owns it') })}</div>`;
  }
  function register(slotId, provider = {}){
    if (typeof provider.mount !== 'function') throw new Error('A People slot provider needs a mount function.');
    const list = providers.get(slotId) || [];
    list.push(provider);
    providers.set(slotId, list);
    waiting.forEach((retry) => { try { retry(slotId); } catch (_) {} });
    return () => { providers.set(slotId, (providers.get(slotId) || []).filter((entry) => entry !== provider)); };
  }
  function mount(container, slotId, context = {}){
    ensureStyles();
    container.classList.add('pp-slot');
    container.dataset.peopleSlot = slotId;
    let handle = null;
    let destroyed = false;
    const fill = () => {
      const provider = providerFor(slotId, context.entity);
      if (!provider) { placeholder(container, slotId); return false; }
      container.replaceChildren();
      try { handle = provider.mount(container, context) || {}; }
      catch (error) { container.innerHTML = `<div class="pp-state" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><strong>${esc(error?.message || t('load_failed', 'Could not load'))}</strong></div>`; handle = {}; }
      return true;
    };
    const retry = (registered) => { if (!destroyed && !handle && registered === slotId && fill()) waiting.delete(retry); };
    if (!fill()) waiting.add(retry);
    return {
      save:async () => { if (typeof handle?.save === 'function') await handle.save(); },
      destroy(){ destroyed = true; waiting.delete(retry); try { handle?.destroy?.(); } catch (_) {} },
      filled:() => !!handle
    };
  }
  /* A tab definition for entityModal.open({ tabs }). */
  function tab(slotId, entity, options = {}){
    const slot = DECLARED[slotId] || { label:() => slotId, icon:'fa-puzzle-piece' };
    return {
      id:slotId,
      /* The slot's own capability ('compensation' and 'fields' in FirstMatePeople.data.ACTIONS); the caller may narrow it. */
      needs:options.needs !== undefined ? options.needs : slotId,
      label:options.label || slot.label(),
      icon:options.icon || slot.icon,
      mount(panel, ctx){
        return mount(panel, slotId, {
          entity,
          orgId:options.orgId || String(window.__APP?.userOrgId || window.__APP?.orgId || ''),
          branchId:options.branchId || String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default'),
          readOnly:options.readOnly === true,
          onDirty:(isDirty = true) => ctx.setDirty(isDirty),
          onSaved:() => { ctx.setDirty(false); ctx.setStatus('saved', t('saved', 'Saved')); }
        });
      }
    };
  }
  /* extra: { home:{ kind, id }, traits:{ has_members, ... }, members:[{ id, name }] } for the panels that need them. */
  const entity = (kind, id, name = '', extra = {}) => ({ kind, id:String(id || ''), key:`${kind}:${id}`, name, ...extra });

  People.slots = { register, mount, tab, entity, declared:() => Object.keys(DECLARED), has:(slotId, ref) => !!providerFor(slotId, ref) };
})();
