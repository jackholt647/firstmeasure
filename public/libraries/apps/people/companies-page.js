/* public/libraries/apps/people/companies-page.js
 *
 * People > outside companies (what an organization calls them comes from
 * terminology; the fallback is "Subcontractors").
 *
 *   FirstMatePeople.companiesPage.mount(container, { entity:'company:<id>', onEntity(key) }) -> { refresh(), openCompany(id), destroy() }
 *
 * A company can have several types, picked from a dropdown. Tabs are chosen by
 * what exists: Overview always; Link when the assignee can be linked (trait
 * `external_link`); Payment terms when Payroll is on; Permissions when the
 * company's permission set can be read. Onboarding and Documents have no
 * backend and are not shown.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.companiesPage) return;
  const kit = People.kit;
  const data = People.data;
  const pageKit = People.pageKit;
  const { esc, t, tip } = kit;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const sorted = (list) => [...list].sort();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const text = (...values) => { for (const value of values) { const clean = String(value ?? '').trim(); if (clean) return clean; } return ''; };
  const hasFlag = (group, flag) => { try { return window.PlatformAPI?.appFlags?.has?.(group, flag) === true; } catch (_) { return false; } };

  function ensureStyles(){
    if (document.getElementById('pp_companies_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_companies_css';
    style.textContent = `
      .pp-link{display:grid;gap:14px;max-width:460px}
      .pp-link-state{display:flex;align-items:center;gap:12px;padding:14px;border-radius:12px;background:var(--pp-soft)}
      .pp-link-state>i{display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:11px;background:var(--pp-panel);border:1px solid var(--pp-line);color:var(--pp-faint);font-size:15px}
      .pp-link-state.linked>i{color:var(--pp-ok);border-color:var(--pp-ok-line);background:var(--pp-ok-bg)}
      .pp-link-state.pending>i{color:var(--pp-warn);border-color:var(--pp-warn-line);background:var(--pp-warn-bg)}
      .pp-link-state>strong{font-size:14px;font-weight:650}
      .pp-company-perm{display:flex;flex-direction:column;height:100%;min-height:0;gap:10px}
      .pp-company-perm>[data-company-perm]{flex:1;min-height:0}
    `;
    document.head.appendChild(style);
  }

  function mount(container, options = {}){
    if (!container) throw new Error('companiesPage.mount requires a container.');
    ensureStyles();
    const can = data.can;
    let query = '';
    let destroyed = false;
    let openEntity = null;
    const labels = () => data.state.groupLabels;
    const plural = () => labels().connectionPlural || t('subcontractors', 'Subcontractors');
    const singular = () => labels().connectionSingular || t('subcontractor', 'Subcontractor');

    function rowModel(company){
      const contact = data.companyContact(company);
      const pill = data.linkPill(company);
      return {
        key:company.id, square:true,
        entity:{ id:company.id, name:company.name, icon:kit.ICONS.company, color:'#475467' },
        title:text(company.name, company.display_name, company.legal_name, company.id),
        secondary:[text(contact.name), text(contact.email, contact.phone)].filter(Boolean).join(' · '),
        marks:[People.onboarding?.mark(company)].filter(Boolean),
        pills:pill ? [pill] : [],
        chipGroups:[{ chips:data.companyTypeIds(company).map((typeId) => ({ label:data.typeName('organization_connection', typeId), tone:'group' })), tone:'group' }, { chips:data.companyDepartments(company).map((department) => ({ label:department.label, color:department.color })) }],
        actions:[{ id:'edit', needs:'companies.view', icon:kit.ICONS.edit, label:t('edit', 'Edit') }, can.settings ? { id:'archive', needs:'companies.edit', icon:'fa-box-archive', label:t('archive', 'Archive'), tone:'danger' } : null],
        hover:`organization_connection:${company.id}`
      };
    }
    let filter = ['linked', 'unlinked'].includes(options.filter) ? options.filter : 'all';
    const permissionSets = new Map();     // read when a company is opened, where the directory publishes them
    const branchFilter = People.branches.filter('subcontractors', { onChange:() => renderList(), bulk:{ kind:'company', items:() => visible() } });
    const visible = () => data.state.connections.filter((company) => branchFilter.matches('company', company)).filter((company) => filter === 'all' || (data.linkStatus(company) === 'linked') === (filter === 'linked')).filter((company) => !query || [company.name, company.legal_name, data.companyContact(company).name, data.companyContact(company).email, ...data.companyTypeIds(company).map((typeId) => data.typeName('organization_connection', typeId))].join(' ').toLowerCase().includes(query))
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
    const subtitle = () => {
      const count = data.state.connections.length;
      const linked = data.state.connections.filter((company) => data.linkStatus(company) === 'linked').length;
      return `${count.toLocaleString()} ${count === 1 ? singular().toLowerCase() : plural().toLowerCase()}${linked ? `, ${linked.toLocaleString()} ${t('linked_count', 'linked')}` : ''}`;
    };
    function renderList(){
      if (destroyed || !data.state.loaded) return;
      list.setItems(visible());
      list.setSubtitle(subtitle());
      const linked = data.state.connections.filter((company) => data.linkStatus(company) === 'linked').length;
      list.setFilters([{ id:'all', label:t('filter_all', 'All') }, { id:'linked', label:t('linked', 'Linked'), count:linked }, { id:'unlinked', label:t('not_linked', 'Not linked'), count:data.state.connections.length - linked }], filter);
    }
    async function archive(company, anchor){
      const yes = await kit.confirm(anchor, { title:t('archive_confirm', 'Archive {name}?', { name:company.name || company.id }), confirmLabel:t('archive', 'Archive'), tone:'danger' });
      if (!yes) return false;
      try { await data.archiveCompany(company.id); kit.toast(t('archived', 'Archived'), company.name || '', true); return true; }
      catch (error) { pageKit.failed(t('not_archived', 'Not archived'), error); return false; }
    }
    const create = (button) => kit.form(button, {
      title:t('new_company', 'New {company}', { company:singular().toLowerCase() }), submitLabel:t('create', 'Create'),
      fields:[{ id:'name', label:t('name', 'Name'), required:true }],
      submit:(values) => data.createCompany({ name:values.name })
    }).then((company) => { if (company?.id) openCompany(company.id, { opener:button }); });

    const list = People.listPage.mount(container, {
      icon:kit.ICONS.company, title:plural(), subtitle:'',
      search:{ placeholder:t('search', 'Search'), onInput(value){ query = value.trim().toLowerCase(); renderList(); } },
      filters:{ items:[{ id:'all', label:t('filter_all', 'All') }], value:filter, onChange(next){ filter = next; renderList(); } },
      actions:[
        { id:'types', needs:'companies.view', label:t('types', 'Types'), icon:'fa-tags', onClick:(button) => pageKit.typesModal({ kind:'organization_connection', opener:button }) },
        People.paySheets ? { id:'pay_sheets', needs:'pay_sheets', label:t('pay_sheets', 'Pay sheets'), icon:'fa-file-invoice-dollar', onClick:(button) => People.paySheets.openList({ opener:button, assigneeKind:'organization_connection' }) } : null, /* pay-sheets-list.js */
        can.settings ? { id:'new', needs:'companies.edit', label:t('new_company', 'New {company}', { company:singular().toLowerCase() }), icon:'fa-plus', primary:true, onClick:create } : null
      ].filter(Boolean),
      empty:{ icon:kit.ICONS.company, title:t('no_companies_yet', 'No {companies} yet', { companies:plural().toLowerCase() }) },
      row:rowModel,
      onOpen:(company, row) => openCompany(company.id, { opener:row.querySelector('[data-row-open]') }),
      onAction:(action, company, button) => { if (action === 'edit') openCompany(company.id, { opener:button }); else if (action === 'archive') archive(company, button); }
    });
    branchFilter.attach(list.controlHost);
    const detachHover = People.hoverCard.attach(list.el, {});
    const unsubscribe = data.subscribe((state, change) => { if (destroyed) return; renderList(); openEntity?.refresh?.(change); });
    async function refresh(force = true){
      try { await data.load({ refresh:force }); renderList(); }
      catch (error) { if (!data.state.loaded) list.setError(error?.message || t('load_failed', 'Could not load'), () => { list.setLoading(true); refresh(true); }); }
    }

    /* The permission set is read first, so the tab exists only when it can show what is saved. */
    async function openCompany(id, extra = {}){
      if (data.allows('companies.permissions') && !permissionSets.has(String(id))) permissionSets.set(String(id), await data.loadCompanyPermissions(id));
      return showCompany(id, extra);
    }
    function showCompany(id, extra = {}){
      const start = data.company(id);
      if (!start) return null;
      const current = () => data.company(id) || start;
      const key = `organization_connection:${id}`;
      const traits = data.traits(key);
      const editable = data.allows('companies.edit');
      const baseline = () => {
        const company = current();
        const contact = data.companyContact(company);
        const address = company.address && typeof company.address === 'object' ? company.address : {};
        const terms = company.payment_terms && typeof company.payment_terms === 'object' ? company.payment_terms : {};
        return {
          name:text(company.name, company.display_name), legal_name:text(company.legal_name), external_reference:text(company.metadata?.external_reference, company.external_reference),
          contact:{ name:text(contact.name), email:text(contact.email), phone:text(contact.phone) },
          address:{ line1:text(address.line1, address.address1), line2:text(address.line2, address.address2), city:text(address.city), region:text(address.region, address.state), postal_code:text(address.postal_code, address.zip) },
          typeIds:data.companyTypeIds(company), scopeIds:[...(company.capability_scope_ids || [])].map(String),
          departmentIds:data.companyDepartments(company).filter((department) => department.direct).map((department) => department.id),
          linked_organization_id:text(company.linked_organization_id, company.linked_org_id),
          terms:{ basis:text(terms.basis, 'payroll_schedule'), net_days:Number(terms.net_days || 0) },
          permissions:permissionSets.get(String(id)) || data.companyPermissions(company)
        };
      };
      let base = baseline();
      const draft = clone(base);
      let permissions = null;
      let permissionsHost = null;
      const dirtyParts = () => ({
        details:!same([draft.name, draft.legal_name, draft.external_reference, draft.contact, draft.address], [base.name, base.legal_name, base.external_reference, base.contact, base.address]),
        types:!same(sorted(draft.typeIds), sorted(base.typeIds)),
        scopes:!same(sorted(draft.scopeIds), sorted(base.scopeIds)),
        departments:!same(sorted(draft.departmentIds), sorted(base.departmentIds)),
        link:draft.linked_organization_id.trim() !== base.linked_organization_id.trim(),
        terms:!same(draft.terms, base.terms),
        company_permissions:!same(draft.permissions, base.permissions)
      });
      const sync = () => Object.entries(dirtyParts()).forEach(([part, dirty]) => modal.setDirty(part, dirty));
      function drawSummary(host){
        const model = data.companySummary(current(), draft);
        model.sections.forEach((section) => {
          if (!editable) return;
          if (!editable) return;
          if (section.id === 'types' && data.types('organization_connection').length) section.action = { id:'types', label:t('change_types', 'Change types') };
          if (section.id === 'departments' && data.allows('departments.members') && data.state.departments.length) section.action = { id:'departments', label:t('change_departments', 'Change departments') };
          if (section.id === 'scopes' && data.state.scopes.length) section.action = { id:'scopes', label:t('change_kinds_of_work', 'Change kinds of work') };
        });
        const branchesSection = People.branches.membershipSection('company', current());
        if (branchesSection) model.sections.push(branchesSection);
        model.sections = model.sections.filter((section) => section.action || section.chips.length);
        host.innerHTML = kit.summary(model, 'panel');
      }
      const input = (path, label, value, extraAttrs = '') => `<label class="pp-field"><span>${esc(label)}</span><input class="pp-input" data-company-field="${esc(path)}" value="${esc(value)}" autocomplete="off" ${editable ? '' : 'disabled'} ${extraAttrs}></label>`;
      const bindFields = (panel) => panel.addEventListener('input', (event) => {
        const field = event.target.closest('[data-company-field]');
        if (!field) return;
        const [head, tail] = field.dataset.companyField.split('.');
        if (tail) draft[head][tail] = field.type === 'number' ? Number(field.value || 0) : field.value; else draft[head] = field.value;
        if (head === 'name' || head === 'legal_name') modal.refreshSummary();
        sync();
      });
      const payroll = hasFlag('apps', 'payroll');
      const entity = data.entityFor('organization_connection', id, start.name);
      const mountPermissions = () => {
        if (!permissionsHost || !draft.permissions) return;
        permissions?.destroy();
        permissionsHost.innerHTML = `<div class="pp-company-perm"><div class="pp-tab-bar"><strong>${esc(t('roles', 'Roles'))}</strong><div class="pp-chip-run wrap" data-company-roles>${draft.permissions.access_role_ids.map((roleId) => kit.chip({ label:data.role(roleId)?.name || roleId, tone:'role' })).join('') || `<span class="pp-sum-empty">${esc(t('none', 'None'))}</span>`}</div>${can.permissions ? `<button type="button" class="pp-icon-btn" data-company-roles-edit aria-label="${esc(t('change_roles', 'Change roles'))}"${tip(t('change_roles', 'Change roles'))}><i class="fas ${kit.ICONS.edit}" aria-hidden="true"></i></button>` : ''}${kit.info(t('company_permissions_tip', "What this company's own people may do on your projects. It is recorded here; it does not change anyone's access yet."))}</div><div data-company-perm></div></div>`;
        permissions = People.permissionsPanel.mount(permissionsHost.querySelector('[data-company-perm]'), { level:'company', groups:data.permissionGroups(), value:draft.permissions.permission_overrides, inherited:(permissionKey) => data.inheritedPermission(draft.permissions.access_role_ids)(permissionKey), readOnly:!can.permissions, onChange(value){ draft.permissions.permission_overrides = value; sync(); } });
        permissionsHost.querySelector('[data-company-roles-edit]')?.addEventListener('click', (event) => pageKit.checkMenu(event.currentTarget, { align:'end', label:t('roles', 'Roles'), items:data.activeRoles().map((role) => ({ id:role.id, label:role.name || role.id, tooltip:role.description })), selected:draft.permissions.access_role_ids, onChange(next){ draft.permissions.access_role_ids = next; mountPermissions(); sync(); } }));
      };
      const tabs = [
        { id:'overview', needs:'companies.view', label:t('overview', 'Overview'), icon:'fa-address-card', mount(panel){
          panel.innerHTML = `<div class="pp-form-grid">
            ${input('name', t('name', 'Name'), draft.name)}${input('legal_name', t('legal_name', 'Legal name'), draft.legal_name)}${input('external_reference', t('external_reference', 'Reference'), draft.external_reference, tip(t('external_reference_tip', 'Your own number or code for this company')))}
            <h5>${esc(t('contact', 'Contact'))}</h5>
            ${input('contact.name', t('name', 'Name'), draft.contact.name)}${input('contact.email', t('email', 'Email'), draft.contact.email, 'type="email"')}${input('contact.phone', t('phone', 'Phone'), draft.contact.phone)}
            <h5>${esc(t('address', 'Address'))}</h5>
            <div class="wide">${input('address.line1', t('address_line1', 'Street'), draft.address.line1)}</div>${input('address.line2', t('address_line2', 'Suite'), draft.address.line2)}
            ${input('address.city', t('city', 'City'), draft.address.city)}${input('address.region', t('region', 'State / region'), draft.address.region)}${input('address.postal_code', t('postal_code', 'Postal code'), draft.address.postal_code)}
          </div>`;
          bindFields(panel);
          return {};
        } },
        People.onboarding ? People.onboarding.companyTab(id) : null,
        traits.external_link ? { id:'link', needs:'companies.view', label:t('link', 'Link'), icon:'fa-link', tooltip:t('link_tip', 'Connect this company to its own organization here, so its people can sign in'), mount(panel){
          const draw = () => {
            const status = data.linkStatus(current());
            panel.innerHTML = `<div class="pp-link"><div class="pp-link-state ${esc(status)}"><i class="fas ${status === 'unlinked' ? 'fa-link-slash' : 'fa-link'}" aria-hidden="true"></i><strong>${esc(status === 'linked' ? t('linked', 'Linked') : status === 'pending' ? t('link_pending', 'Link pending') : t('not_linked', 'Not linked'))}</strong></div>
              ${input('linked_organization_id', t('linked_organization_id', 'Their organization ID'), draft.linked_organization_id, tip(t('linked_organization_tip', 'The ID of the company’s own organization. Saving it asks for the link; it shows as linked once it is confirmed.')))}</div>`;
            People.onboarding?.inviteSection(panel.querySelector('.pp-link'), current());
          };
          draw();
          bindFields(panel);
          // The link state follows the record (an invitation changes it) unless someone is typing the organization ID.
          const offLink = data.subscribe(() => { if (!(panel.contains(document.activeElement) && document.activeElement.matches('input'))) draw(); });
          return { show:draw, destroy:offLink };
        } } : null,
        payroll ? { id:'terms', needs:'companies.terms', label:t('payment_terms', 'Payment terms'), icon:'fa-file-invoice-dollar', mount(panel){
          const draw = () => {
            panel.innerHTML = `<div class="pp-form-grid"><label class="pp-field"><span>${esc(t('paid', 'Paid'))}</span>${kit.select({ value:draft.terms.basis, options:[{ value:'payroll_schedule', label:t('terms_payroll_schedule', 'On the pay schedule') }, { value:'net_days', label:t('terms_net_days', 'Net days after the work') }], label:t('paid', 'Paid'), attrs:'data-company-terms', disabled:!editable })}</label>${draft.terms.basis === 'net_days' ? `<label class="pp-field"><span>${esc(t('net_days', 'Days'))}</span><input class="pp-input" type="number" min="0" max="365" step="1" data-company-field="terms.net_days" value="${esc(draft.terms.net_days)}" ${editable ? '' : 'disabled'}></label>` : ''}</div>`;
          };
          draw();
          bindFields(panel);
          panel.addEventListener('change', (event) => { if (!event.target.matches('[data-company-terms]')) return; draft.terms.basis = event.target.value; if (draft.terms.basis !== 'net_days') draft.terms.net_days = 0; else if (!draft.terms.net_days) draft.terms.net_days = 30; draw(); sync(); });
          return {};
        } } : null,
        draft.permissions ? { id:'permissions', needs:'companies.permissions', label:t('permissions', 'Permissions'), icon:kit.ICONS.permissions, mount(panel){ permissionsHost = panel; mountPermissions(); return { destroy:() => permissions?.destroy() }; } } : null,
        People.slots.tab('compensation', entity, { readOnly:!can.settings }),
        People.slots.tab('pay_sheets', entity, { readOnly:!can.settings }),
        People.slots.tab('fields', entity, { readOnly:!can.settings })
      ].filter(Boolean);
      const modal = People.entityModal.open({
        label:text(start.name, singular()), opener:extra.opener, returnFocus:() => list.rowElement(id)?.querySelector('[data-row-open]'), tab:extra.tab,
        summary:drawSummary,
        actions:() => editable ? [{ id:'archive', needs:'companies.edit', icon:'fa-box-archive', label:t('archive', 'Archive'), tone:'danger', onClick:async (button) => { if (await archive(current(), button)) modal.close(true); } }] : [],
        tabs,
        async onSave(){
          const dirty = dirtyParts();
          if (dirty.terms) await data.savePaymentTerms(id, draft.terms);
          const patch = {};
          if (dirty.details) Object.assign(patch, { name:draft.name, legal_name:draft.legal_name, external_reference:draft.external_reference, contact:draft.contact, address:draft.address });
          if (dirty.scopes) patch.scopeIds = draft.scopeIds;
          if (dirty.link) patch.linked_organization_id = draft.linked_organization_id;
          if (Object.keys(patch).length) await data.saveCompany(id, patch);
          if (dirty.types) await data.setCompanyTypes(id, draft.typeIds);
          if (dirty.departments) await data.saveSubjectDepartments('connection', id, draft.departmentIds);
          if (dirty.company_permissions) { await data.saveCompanyPermissions(id, draft.permissions); permissionSets.set(String(id), JSON.parse(JSON.stringify(draft.permissions))); }
          base = baseline();
          Object.assign(draft, clone(base));
          modal.refreshSummary();
        },
        onClose(){ if (openEntity?.modal === modal) { openEntity = null; options.onEntity?.(''); } }
      });
      modal.el.querySelector('[data-modal-summary]').addEventListener('click', (event) => {
        const button = event.target.closest('[data-people-section-action]');
        if (!button) return;
        const section = button.dataset.peopleSectionAction;
        const refocus = () => modal.el.querySelector(`[data-people-section-action="${section}"]`)?.focus();
        const apply = (field) => (next) => { draft[field] = next; modal.refreshSummary(); sync(); };
        if (section === 'branches') { People.branches.editMembership(button, 'company', current(), refocus); return; }
        if (section === 'types') pageKit.checkMenu(button, { label:t('types', 'Types'), items:data.types('organization_connection').map((type) => ({ id:type.id, label:type.name, tooltip:type.description })), selected:draft.typeIds, onChange:apply('typeIds'), refocus });
        else if (section === 'departments') pageKit.checkMenu(button, { label:labels().departmentPlural, items:data.state.departments.map((department) => ({ id:department.id, label:department.label || department.id, color:department.color })), selected:draft.departmentIds, onChange:apply('departmentIds'), refocus });
        else if (section === 'scopes') pageKit.checkMenu(button, { label:t('kinds_of_work', 'Kinds of work'), items:data.state.scopes.map((scope) => ({ id:scope.id, label:scope.name })), selected:draft.scopeIds, onChange:apply('scopeIds'), refocus });
      });
      openEntity = { key:`company:${id}`, modal, refresh(){
        if (!data.company(id)) { modal.close(true); return; }
        if (!modal.isDirty()) { base = baseline(); Object.assign(draft, clone(base)); modal.refreshSummary(); }
      } };
      options.onEntity?.(openEntity.key);
      sync();
      return modal;
    }

    refresh(false).then(() => {
      if (destroyed || !options.entity) return;
      const [kind, ...rest] = String(options.entity).split(':');
      if (kind === 'company') openCompany(rest.join(':'));
    });
    return {
      refresh:() => refresh(true), openCompany,
      destroy(){ destroyed = true; unsubscribe(); branchFilter.destroy(); detachHover(); People.hoverCard.hide(); openEntity?.modal.close(true); list.destroy(); }
    };
  }

  People.companiesPage = { mount };
  People.views.register('subcontractors', mount);
})();
