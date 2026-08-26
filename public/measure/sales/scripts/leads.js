(function(){
  "use strict";

  const cfg = window.LEADS_CFG || {};
  const apiBase = String(cfg.apiBase || "/v1").replace(/\/+$/, "");
  const user = cfg.user || {};
  const state = {
    fields: [],
    visible: new Set(),
    leads: [],
    selectionMode: "explicit",
    selected: new Set(),
    excluded: new Set(),
    selectionQuery: null,
    selectionTotal: 0,
    selectionSummary: null,
    selectedView: false,
    page: 1,
    perPage: 100,
    total: 0,
    totalPages: 1,
    sort: "updated_at",
    dir: "desc",
    lastClicked: null,
    dragMode: null,
    dragStartIndex: null,
    dragLastIndex: null,
    footerFrame: 0,
    importId: "",
    activeLeadId: "",
    leadViewer: null,
    filterOptions: {}
  };

  const els = {};
  const columnStorageKey = `firstmeasure.sales.leadColumns.v1.${String(user.email || "default").toLowerCase()}`;
  const viewStorageKey = `firstmeasure.sales.leadView.v1.${String(user.email || "default").toLowerCase()}`;

  document.addEventListener("DOMContentLoaded", init);
  document.addEventListener("click", closeFloatingPanels);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hide(qs("#notes-popover"));
    }
  });

  async function init(){
    try {
      bindElements();
      bindEvents();
      if (!user.manager) qsAll(".manager-only").forEach((node) => node.remove());
      qs("#lead-scope-label").textContent = user.scopeLabel || (user.manager ? "Manager view: all leads" : `Assigned to ${user.email || "you"}`);
      await loadFields();
      restoreViewState();
      await loadLeads();
      document.body.addEventListener("mouseup", endDragSelection);
      document.addEventListener("mousemove", handleDragMouseMove);
    } catch (error) {
      showLoadError(error);
    }
  }

  function bindElements(){
    ["lead-search","lead-status","lead-region","lead-assigned","lead-disposition","lead-presence","lead-imported-from","lead-imported-to","custom-topbar-filters","lead-refresh","lead-columns","lead-import","lead-actions","selected-summary","reassign-selected","export-selected","lead-loading","sheet-scroll","lead-table","lead-head","lead-body","select-visible","select-filtered","view-selected","deselect-all","page-summary","per-page","prev-page","page-number","next-page","columns-modal","columns-panel","custom-column-name","custom-column-type","custom-column-options","custom-column-topbar","add-custom-column","notes-popover","lead-viewer-modal","viewer-title","viewer-subtitle","viewer-open-page","lead-viewer-body","import-modal","import-file","import-text","preview-import","new-action","duplicate-action","unchanged-action","commit-import","import-summary","reassign-modal","reassign-people","reassign-preview","preview-reassign","commit-reassign"].forEach((id) => {
      els[camel(id)] = qs(`#${id}`);
    });
  }

  function bindEvents(){
    els.leadSearch.addEventListener("input", debounce(() => { state.page = 1; saveViewState(); loadLeads(); }, 250));
    els.leadStatus.addEventListener("change", resetAndLoad);
    els.leadRegion.addEventListener("change", resetAndLoad);
    if (els.leadAssigned) els.leadAssigned.addEventListener("change", resetAndLoad);
    els.leadDisposition.addEventListener("change", resetAndLoad);
    els.leadPresence.addEventListener("change", resetAndLoad);
    els.leadImportedFrom.addEventListener("change", resetAndLoad);
    els.leadImportedTo.addEventListener("change", resetAndLoad);
    els.leadRefresh.addEventListener("click", () => loadLeads());
    els.leadColumns.addEventListener("click", () => openColumnsModal());
    els.leadImport.addEventListener("click", () => els.importModal.showModal());
    els.selectVisible.addEventListener("click", selectVisible);
    els.selectFiltered.addEventListener("click", selectFiltered);
    els.viewSelected.addEventListener("click", toggleSelectedView);
    els.deselectAll.addEventListener("click", clearSelection);
    els.exportSelected.addEventListener("click", exportSelectedCsv);
    if (els.reassignSelected) els.reassignSelected.addEventListener("click", openReassignModal);
    if (els.previewReassign) els.previewReassign.addEventListener("click", previewReassign);
    if (els.commitReassign) els.commitReassign.addEventListener("click", commitReassign);
    if (els.addCustomColumn) els.addCustomColumn.addEventListener("click", createCustomColumn);
    if (els.customColumnType) els.customColumnType.addEventListener("change", updateCustomOptionsState);
    els.perPage.addEventListener("change", () => { state.perPage = Number(els.perPage.value) || 100; state.page = 1; saveViewState(); loadLeads(); });
    els.prevPage.addEventListener("click", () => { if (state.page > 1) { state.page -= 1; saveViewState(); loadLeads(); } });
    els.nextPage.addEventListener("click", () => { if (state.page < state.totalPages) { state.page += 1; saveViewState(); loadLeads(); } });
    els.previewImport.addEventListener("click", previewImport);
    els.commitImport.addEventListener("click", commitImport);
    els.importFile.addEventListener("change", readImportFile);
  }

  async function loadFields(){
    const response = await request("/internal/crm/leads/fields");
    state.fields = response.fields || [];
    const saved = safeJson(localStorage.getItem(columnStorageKey), null);
    const visible = Array.isArray(saved) ? saved : state.fields.filter((field) => field.defaultVisible).map((field) => field.key);
    state.visible = new Set(visible.filter((key) => state.fields.some((field) => field.key === key)));
    if (Array.isArray(saved) && state.fields.some((field) => field.key === "imported_at") && !localStorage.getItem(`${columnStorageKey}.importDateAdded`)) {
      state.visible.add("imported_at");
      localStorage.setItem(columnStorageKey, JSON.stringify([...state.visible]));
      localStorage.setItem(`${columnStorageKey}.importDateAdded`, "1");
    }
    renderHead();
    renderColumnsPanel();
    renderCustomTopbarFilters();
    await loadFilterOptions();
    updateCustomOptionsState();
  }

  async function loadFilterOptions(){
    const response = await request("/internal/crm/leads/filter-options", {
      method: "POST",
      body: {
        manager: Boolean(user.manager),
        actor_email: user.email || ""
      }
    });
    state.filterOptions = response.options || {};
    renderFilterOptions();
  }

  async function loadLeads(){
    setBusy(true);
    let failed = false;
    try {
      const payload = {
        page: state.page,
        per_page: state.perPage,
        q: els.leadSearch.value.trim(),
        sort: state.sort,
        dir: state.dir,
        manager: Boolean(user.manager),
        actor_email: user.email || "",
        filters: buildFilters()
      };
      if (selectedCount() > 0) {
        payload.selection = selectionPayload();
        payload.selection_summary_query = currentQueryPayload();
        if (state.selectedView) payload.selection_view = true;
      }
      const response = await request("/internal/crm/leads/query", { method: "POST", body: payload });
      state.leads = response.leads || [];
      state.total = Number(response.total || 0);
      state.totalPages = Math.max(1, Number(response.total_pages || 1));
      state.page = Number(response.page || state.page);
      state.selectionSummary = response.selection_summary || null;
      saveViewState();
      updateSelectedViewState();
      updateScopeLabel();
      renderHead();
      renderRows();
      renderFooter();
    } catch (error) {
      failed = true;
      showLoadError(error);
    } finally {
      if (!failed) setBusy(false);
    }
  }

  function buildFilters(){
    const filters = {};
    if (els.leadStatus.value) filters.status = els.leadStatus.value;
    if (els.leadRegion.value.trim()) filters.region = els.leadRegion.value.trim();
    if (els.leadAssigned && els.leadAssigned.value.trim()) filters.assigned_to_email = els.leadAssigned.value.trim();
    if (els.leadDisposition.value.trim()) filters.disposition = els.leadDisposition.value.trim();
    if (els.leadPresence.value) filters[els.leadPresence.value] = true;
    if (els.leadImportedFrom.value) filters.imported_from = els.leadImportedFrom.value;
    if (els.leadImportedTo.value) filters.imported_to = els.leadImportedTo.value;
    for (const field of customFields().filter((item) => item.topbarFilter)) {
      const control = qs(`#filter-${cssEscape(field.key)}`);
      if (control && control.value) filters[field.key] = control.value;
    }
    return filters;
  }

  function restoreViewState(){
    const saved = safeJson(localStorage.getItem(viewStorageKey), null);
    if (!saved || typeof saved !== "object") return;
    state.page = Math.max(1, Number(saved.page || 1) || 1);
    state.perPage = Math.max(1, Math.min(500, Number(saved.perPage || 100) || 100));
    state.sort = String(saved.sort || state.sort);
    state.dir = String(saved.dir || state.dir).toLowerCase() === "asc" ? "asc" : "desc";
    els.perPage.value = String(state.perPage);
    els.leadSearch.value = String(saved.q || "");
    setSelectValue(els.leadStatus, saved.status);
    setSelectValue(els.leadRegion, saved.region);
    if (els.leadAssigned) setSelectValue(els.leadAssigned, saved.assigned_to_email);
    setSelectValue(els.leadDisposition, saved.disposition);
    setSelectValue(els.leadPresence, saved.presence);
    if (els.leadImportedFrom) els.leadImportedFrom.value = String(saved.imported_from || "");
    if (els.leadImportedTo) els.leadImportedTo.value = String(saved.imported_to || "");
    for (const [key, value] of Object.entries(saved.customFilters || {})) {
      const control = qs(`#filter-${cssEscape(key)}`);
      if (control) setControlValue(control, value);
    }
  }

  function saveViewState(){
    const value = {
      page: state.page,
      perPage: state.perPage,
      sort: state.sort,
      dir: state.dir,
      q: els.leadSearch ? els.leadSearch.value.trim() : "",
      status: els.leadStatus ? els.leadStatus.value : "",
      region: els.leadRegion ? els.leadRegion.value : "",
      assigned_to_email: els.leadAssigned ? els.leadAssigned.value : "",
      disposition: els.leadDisposition ? els.leadDisposition.value : "",
      presence: els.leadPresence ? els.leadPresence.value : "",
      imported_from: els.leadImportedFrom ? els.leadImportedFrom.value : "",
      imported_to: els.leadImportedTo ? els.leadImportedTo.value : "",
      customFilters: Object.fromEntries(customFields().filter((field) => field.topbarFilter).map((field) => {
        const control = qs(`#filter-${cssEscape(field.key)}`);
        return [field.key, control ? control.value : ""];
      }))
    };
    localStorage.setItem(viewStorageKey, JSON.stringify(value));
  }

  function setSelectValue(select, value){
    if (!select) return;
    const raw = String(value || "");
    select.value = [...select.options].some((option) => option.value === raw) ? raw : "";
  }

  function setControlValue(control, value){
    if (!control) return;
    if (control.tagName === "SELECT") setSelectValue(control, value);
    else control.value = String(value || "");
  }

  function renderHead(){
    const columns = visibleFields();
    const header = document.createElement("tr");
    header.innerHTML = `<th class="row-num">#</th><th class="check-col"><input type="checkbox" aria-label="Select visible rows"></th>`;
    header.querySelector("input").checked = state.leads.length > 0 && state.leads.every((lead) => isLeadSelected(String(lead.id)));
    header.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) selectVisible();
      else state.leads.forEach((lead) => setLeadSelected(String(lead.id), false));
      syncVisibleSelectionRows();
      renderFooter();
    });
    for (const field of columns) {
      const th = document.createElement("th");
      th.dataset.key = field.key;
      th.textContent = `${field.label}${state.sort === field.key ? (state.dir === "asc" ? " ↑" : " ↓") : ""}`;
      if (field.sortable) th.addEventListener("click", () => sortBy(field.key));
      header.appendChild(th);
    }
    const openTh = document.createElement("th");
    openTh.className = "open-col";
    openTh.textContent = "Open";
    header.appendChild(openTh);
    els.leadHead.replaceChildren(header);
  }

  function renderRows(){
    const columns = visibleFields();
    const fragment = document.createDocumentFragment();
    state.leads.forEach((lead, index) => {
      const id = String(lead.id);
      const row = document.createElement("tr");
      row.dataset.id = id;
      row.dataset.index = String(index);
      if (isLeadSelected(id)) row.classList.add("is-selected");
      row.innerHTML = `<td class="row-num">${((state.page - 1) * state.perPage) + index + 1}</td><td class="check-col"><input type="checkbox" ${isLeadSelected(id) ? "checked" : ""} aria-label="Select row"></td>`;
      const checkbox = row.querySelector("input");
      checkbox.addEventListener("mousedown", (event) => {
        event.stopPropagation();
      });
      checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleRow(id, index, event);
      });
      row.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        if (event.target.closest(".open-col, .open-lead-button, a, button, input, select, textarea")) return;
        event.preventDefault();
        beginDragSelection(id, index, event);
      });
      row.addEventListener("mouseenter", () => {
        if (!state.dragMode) return;
        handleDragToIndex(index);
      });
      for (const field of columns) row.appendChild(cellFor(field, lead));
      row.appendChild(openCell(lead));
      fragment.appendChild(row);
    });
    els.leadBody.replaceChildren(fragment);
  }

  function cellFor(field, lead){
    const td = document.createElement("td");
    const value = lead[field.key];
    if (field.type === "date") {
      td.textContent = formatDate(value);
      td.className = "date-cell";
      return td;
    }
    if (field.type === "url" && value) {
      const a = document.createElement("a");
      a.href = String(value);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = trimText(value, 34);
      td.appendChild(a);
      return td;
    }
    if (field.type === "notes") {
      const span = document.createElement("span");
      span.className = "note-hover";
      span.textContent = Number(value || 0) ? `Notes ${value}` : "Notes";
      span.addEventListener("mouseenter", (event) => {
        event.stopPropagation();
        showNoteTooltip(span, lead.latest_note_preview || "No recent note");
      });
      span.addEventListener("mouseleave", () => hide(els.notesPopover));
      td.appendChild(span);
      return td;
    }
    td.textContent = trimText(value, field.key === "address" ? 48 : 36);
    td.title = String(value || "");
    return td;
  }

  function openCell(lead){
    const td = document.createElement("td");
    td.className = "open-col";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "open-lead-button";
    button.textContent = "Open";
    td.addEventListener("mousedown", stopTableSelection);
    td.addEventListener("pointerdown", stopTableSelection);
    button.addEventListener("mousedown", stopTableSelection);
    button.addEventListener("pointerdown", stopTableSelection);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openLeadViewer(lead.id);
    });
    td.appendChild(button);
    return td;
  }

  function toggleRow(id, index, event){
    if (event.shiftKey && state.lastClicked !== null) {
      const start = Math.min(state.lastClicked, index);
      const end = Math.max(state.lastClicked, index);
      for (let i = start; i <= end; i += 1) {
        const lead = state.leads[i];
        if (lead) setLeadSelected(String(lead.id), true);
      }
    } else if (event.ctrlKey || event.metaKey) {
      setLeadSelected(id, !isLeadSelected(id));
      state.lastClicked = index;
    } else {
      setLeadSelected(id, !isLeadSelected(id));
      state.lastClicked = index;
    }
    syncVisibleSelectionRows();
    renderFooter();
  }

  function renderFooter(){
    const selected = selectedCount();
    if (selected === 0 && state.selectedView) {
      state.selectedView = false;
      updateSelectedViewState();
    }
    const outside = Number(state.selectionSummary && state.selectionSummary.outside_current_filter || 0);
    els.selectedSummary.textContent = state.selectionMode === "filtered"
      ? `${selected.toLocaleString()} selected from filter${state.excluded.size ? `, ${state.excluded.size.toLocaleString()} excluded` : ""}`
      : `${selected.toLocaleString()} selected`;
    if (!state.selectedView && outside > 0) {
      els.selectedSummary.textContent += `, ${outside.toLocaleString()} outside current filter`;
    }
    els.exportSelected.disabled = selected === 0;
    els.viewSelected.disabled = selected === 0;
    els.viewSelected.textContent = state.selectedView ? "Show filtered" : "View selected";
    els.viewSelected.classList.toggle("is-active", state.selectedView);
    if (els.reassignSelected) els.reassignSelected.disabled = selected === 0;
    els.leadActions.classList.toggle("is-disabled", selected === 0);
    els.pageSummary.textContent = `${state.total.toLocaleString()} ${state.selectedView ? "selected leads" : "leads"}, ${state.leads.length.toLocaleString()} on page`;
    els.pageNumber.textContent = `Page ${state.page} of ${state.totalPages}`;
    els.prevPage.disabled = state.page <= 1;
    els.nextPage.disabled = state.page >= state.totalPages;
  }

  function updateScopeLabel(){
    const label = qs("#lead-scope-label");
    if (!label) return;
    const total = state.total.toLocaleString();
    label.textContent = user.manager
      ? `Manager view: all leads (${total})`
      : `Assigned to ${user.email || "you"} (${total})`;
  }

  function renderColumnsPanel(){
    const panel = els.columnsPanel;
    const list = document.createElement("div");
    list.className = "column-list";
    state.fields.forEach((field) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `column-toggle${state.visible.has(field.key) ? " is-on" : ""}`;
      button.setAttribute("aria-pressed", state.visible.has(field.key) ? "true" : "false");
      button.innerHTML = `
        <span class="toggle-track"><span class="toggle-knob"></span></span>
        <span class="column-toggle-label">${escapeHtml(field.label)}</span>
        ${field.custom ? `<span class="custom-column-actions"><span class="mini-button custom-filter-toggle">${field.topbarFilter ? "Filter on" : "Filter off"}</span><span class="mini-button danger custom-delete">Delete</span></span>` : ""}
      `;
      button.addEventListener("click", () => {
        if (state.visible.has(field.key)) state.visible.delete(field.key);
        else state.visible.add(field.key);
        localStorage.setItem(columnStorageKey, JSON.stringify([...state.visible]));
        button.classList.toggle("is-on", state.visible.has(field.key));
        button.setAttribute("aria-pressed", state.visible.has(field.key) ? "true" : "false");
        renderHead();
        renderRows();
      });
      if (field.custom) {
        button.querySelector(".custom-filter-toggle").addEventListener("click", async (event) => {
          event.stopPropagation();
          await updateCustomColumn(field.customKey || field.key, { topbar_filter: !field.topbarFilter });
        });
        button.querySelector(".custom-delete").addEventListener("click", async (event) => {
          event.stopPropagation();
          if (!confirm(`Delete custom column "${field.label}"?`)) return;
          await deleteCustomColumn(field.customKey || field.key);
        });
      }
      list.appendChild(button);
    });
    panel.replaceChildren(list);
  }

  function renderFilterOptions(){
    renderSelectOptions(els.leadStatus, "All statuses", state.filterOptions.status || []);
    renderSelectOptions(els.leadRegion, "All regions", state.filterOptions.region || []);
    if (els.leadAssigned) renderSelectOptions(els.leadAssigned, "All assignees", state.filterOptions.assigned_to_email || []);
    renderSelectOptions(els.leadDisposition, "All dispositions", state.filterOptions.disposition || []);
    for (const field of customFields().filter((item) => item.topbarFilter)) {
      const control = qs(`#filter-${cssEscape(field.key)}`);
      if (!control) continue;
      if (field.type === "text") continue;
      renderSelectOptions(control, `All ${field.label}`, (state.filterOptions.custom && state.filterOptions.custom[field.key]) || []);
    }
    renderReassignPeople();
  }

  function renderCustomTopbarFilters(){
    if (!els.customTopbarFilters) return;
    const fragment = document.createDocumentFragment();
    for (const field of customFields().filter((item) => item.topbarFilter)) {
      const id = `filter-${field.key}`;
      let control;
      if (field.type === "text") {
        control = document.createElement("input");
        control.type = "search";
        control.placeholder = field.label;
      } else {
        control = document.createElement("select");
        control.innerHTML = `<option value="">All ${escapeHtml(field.label)}</option>`;
      }
      control.id = id;
      control.className = "filter-input filter-control custom-filter-control";
      control.addEventListener("input", field.type === "text" ? debounce(resetAndLoad, 250) : resetAndLoad);
      control.addEventListener("change", resetAndLoad);
      fragment.appendChild(control);
    }
    els.customTopbarFilters.replaceChildren(fragment);
  }

  async function createCustomColumn(){
    const label = els.customColumnName.value.trim();
    if (!label) return;
    const type = els.customColumnType.value;
    const response = await request("/internal/crm/leads/custom-fields", {
      method: "POST",
      body: {
        label,
        data_type: type,
        options: els.customColumnOptions.value,
        topbar_filter: els.customColumnTopbar.checked,
        actor_email: user.email || ""
      }
    });
    els.customColumnName.value = "";
    els.customColumnOptions.value = "";
    els.customColumnTopbar.checked = false;
    if (response.field && response.field.key) {
      state.visible.add(response.field.key);
      localStorage.setItem(columnStorageKey, JSON.stringify([...state.visible]));
    }
    await reloadFieldConfig();
  }

  async function updateCustomColumn(fieldKey, patch){
    await request(`/internal/crm/leads/custom-fields/${encodeURIComponent(fieldKey)}`, {
      method: "PATCH",
      body: { ...patch, actor_email: user.email || "" }
    });
    await reloadFieldConfig();
  }

  async function deleteCustomColumn(fieldKey){
    await request(`/internal/crm/leads/custom-fields/${encodeURIComponent(fieldKey)}`, {
      method: "DELETE",
      body: { actor_email: user.email || "" }
    });
    state.visible.delete(`custom_${fieldKey}`);
    localStorage.setItem(columnStorageKey, JSON.stringify([...state.visible]));
    await reloadFieldConfig();
  }

  async function reloadFieldConfig(){
    await loadFields();
    restoreViewState();
    await loadLeads();
  }

  function updateCustomOptionsState(){
    if (!els.customColumnType || !els.customColumnOptions) return;
    const needsOptions = els.customColumnType.value === "select" || els.customColumnType.value === "multiselect";
    els.customColumnOptions.disabled = !needsOptions;
    els.customColumnOptions.placeholder = needsOptions ? "Options, comma separated" : "Options only for selections";
  }

  function customFields(){
    return state.fields.filter((field) => field.custom);
  }

  function renderSelectOptions(select, emptyLabel, options){
    if (!select) return;
    const current = select.value;
    select.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>${options.map((option) => {
      const value = String(option.value || "");
      const count = Number(option.count || 0);
      const label = option.label || value;
      return `<option value="${escapeAttr(value)}">${escapeHtml(label)}${count ? ` (${count.toLocaleString()})` : ""}</option>`;
    }).join("")}`;
    select.value = [...select.options].some((option) => option.value === current) ? current : "";
  }

  function showNoteTooltip(anchor, text){
    const panel = els.notesPopover;
    panel.innerHTML = `<div class="panel-title">Recent Note</div><div class="muted">${escapeHtml(text || "No recent note")}</div>`;
    show(panel);
    placeNoteTooltip(panel, anchor);
  }

  function renderReassignPeople(){
    if (!els.reassignPeople) return;
    const assignees = (state.filterOptions.assigned_to_email || []).filter((option) => option.value && option.value !== "__unassigned__");
    els.reassignPeople.innerHTML = assignees.map((option) => `
      <button class="person-toggle" type="button" data-email="${escapeAttr(option.value)}">
        <strong>${escapeHtml(option.label || option.value)}</strong>
        <span>${Number(option.count || 0).toLocaleString()} leads</span>
      </button>
    `).join("");
    els.reassignPeople.querySelectorAll(".person-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        button.classList.toggle("is-selected");
        renderLocalReassignPreview();
      });
    });
  }

  function openReassignModal(){
    if (!user.manager || !els.reassignModal) return;
    renderReassignPeople();
    els.reassignPreview.textContent = "Choose one or more salespeople.";
    els.commitReassign.disabled = true;
    els.reassignModal.showModal();
  }

  function selectedReassignEmails(){
    return Array.from(els.reassignPeople.querySelectorAll(".person-toggle.is-selected"))
      .map((button) => button.dataset.email)
      .filter(Boolean);
  }

  function renderLocalReassignPreview(){
    const emails = selectedReassignEmails();
    const total = selectedCount();
    if (!emails.length) {
      els.reassignPreview.textContent = "Choose one or more salespeople.";
      els.commitReassign.disabled = true;
      return;
    }
    const base = Math.floor(total / emails.length);
    const extra = total % emails.length;
    els.reassignPreview.innerHTML = emails.map((email, index) => `<div><strong>${escapeHtml(email)}</strong>: ${(base + (index < extra ? 1 : 0)).toLocaleString()} leads</div>`).join("");
    els.commitReassign.disabled = false;
  }

  async function previewReassign(){
    const emails = selectedReassignEmails();
    if (!emails.length) return renderLocalReassignPreview();
    els.reassignPreview.textContent = "Building preview...";
    const response = await request("/internal/crm/leads/reassign", {
      method: "POST",
      body: {
        dry_run: true,
        manager: Boolean(user.manager),
        actor_email: user.email || "",
        assignees: emails,
        selection: selectionPayload()
      }
    });
    els.reassignPreview.innerHTML = (response.assignees || []).map((item) => `<div><strong>${escapeHtml(item.email)}</strong>: ${Number(item.count || 0).toLocaleString()} leads</div>`).join("");
    els.commitReassign.disabled = Number(response.total || 0) === 0;
  }

  async function commitReassign(){
    const emails = selectedReassignEmails();
    if (!emails.length) return;
    els.reassignPreview.textContent = "Reassigning leads...";
    const response = await request("/internal/crm/leads/reassign", {
      method: "POST",
      body: {
        dry_run: false,
        manager: Boolean(user.manager),
        actor_email: user.email || "",
        assignees: emails,
        selection: selectionPayload()
      }
    });
    els.reassignPreview.innerHTML = `<strong>Reassigned ${Number(response.total || 0).toLocaleString()} leads.</strong>`;
    clearSelection();
    await loadFilterOptions();
    await loadLeads();
  }

  async function openLeadViewer(leadId){
    state.activeLeadId = leadId;
    els.viewerTitle.textContent = "Loading lead...";
    els.viewerSubtitle.textContent = "";
    els.viewerOpenPage.href = `lead.php?id=${encodeURIComponent(leadId)}`;
    els.leadViewerBody.innerHTML = `<div class="muted">Loading...</div>`;
    els.leadViewerModal.showModal();
    if (!state.leadViewer) {
      state.leadViewer = window.FirstMeasureLeadViewer.create({
        apiBase,
        user,
        fields: () => state.fields,
        els: {
          title: els.viewerTitle,
          subtitle: els.viewerSubtitle,
          body: els.leadViewerBody
        },
        onLeadPatch: updateLocalLeadFromViewer,
        onActivityChange: updateLocalLeadFromViewer
      });
    }
    await state.leadViewer.open(leadId);
  }

  function updateLocalLeadFromViewer(lead){
    const id = String(lead && lead.id || state.activeLeadId || "");
    if (!id) return;
    const existing = state.leads.find((item) => String(item.id) === id);
    if (existing) Object.assign(existing, lead);
  }

  async function previewImport(){
    const rows = parseCsv(els.importText.value);
    if (!rows.length) {
      els.importSummary.textContent = "Add CSV rows before previewing.";
      return;
    }
    els.importSummary.textContent = "Previewing import...";
    const response = await request("/internal/crm/leads/imports/preview", {
      method: "POST",
      body: { actor_email: user.email || "", rows }
    });
    state.importId = response.import_id;
    els.commitImport.disabled = false;
    const summary = response.summary || {};
    els.importSummary.innerHTML = `<strong>${Number(summary.total || 0).toLocaleString()} rows previewed.</strong> ${Number(summary.new_count || 0).toLocaleString()} new, ${Number(summary.duplicate_count || 0).toLocaleString()} changed, ${Number(summary.unchanged_count || 0).toLocaleString()} identical, ${Number(summary.invalid_count || 0).toLocaleString()} invalid.`;
  }

  async function commitImport(){
    if (!state.importId) return;
    els.importSummary.textContent = "Committing import...";
    els.commitImport.disabled = true;
    try {
      const response = await request(`/internal/crm/leads/imports/${encodeURIComponent(state.importId)}/commit`, {
        method: "POST",
        body: {
          actor_email: user.email || "",
          new_action: els.newAction.value,
          duplicate_action: els.duplicateAction.value,
          unchanged_action: els.unchangedAction.value
        }
      });
      const counts = response.counts || {};
      els.importSummary.innerHTML = `<strong>Import complete.</strong> Created ${Number(counts.created || 0).toLocaleString()}, updated ${Number(counts.updated || 0).toLocaleString()}, identical synced ${Number(counts.unchanged || 0).toLocaleString()}, skipped ${Number(counts.skipped || 0).toLocaleString()}, invalid ${Number(counts.invalid || 0).toLocaleString()}.`;
      state.importId = "";
      await loadLeads();
    } catch (error) {
      els.commitImport.disabled = false;
      els.importSummary.innerHTML = `<strong>Import failed.</strong> ${escapeHtml(error.message || "An unexpected error occurred.")}`;
    }
  }

  function selectionPayload(){
    return state.selectionMode === "filtered"
      ? {
          mode: "filtered",
          excluded_ids: [...state.excluded],
          query: state.selectionQuery || currentQueryPayload()
        }
      : {
          mode: "explicit",
          ids: [...state.selected]
        };
  }

  function currentQueryPayload(){
    return {
      q: els.leadSearch.value.trim(),
      manager: Boolean(user.manager),
      actor_email: user.email || "",
      filters: buildFilters()
    };
  }

  function isLeadSelected(id){
    return state.selectionMode === "filtered" ? !state.excluded.has(id) : state.selected.has(id);
  }

  function setLeadSelected(id, selected){
    if (state.selectionMode === "filtered") {
      const wasSelected = !state.excluded.has(id);
      if (selected) state.excluded.delete(id);
      else state.excluded.add(id);
      return wasSelected !== selected;
    }
    const wasSelected = state.selected.has(id);
    if (selected) state.selected.add(id);
    else state.selected.delete(id);
    return wasSelected !== selected;
  }

  function selectedCount(){
    return state.selectionMode === "filtered" ? Math.max(0, state.selectionTotal - state.excluded.size) : state.selected.size;
  }

  function clearSelection(){
    state.selectionMode = "explicit";
    state.selected.clear();
    state.excluded.clear();
    state.selectionQuery = null;
    state.selectionTotal = 0;
    state.selectionSummary = null;
    state.selectedView = false;
    updateSelectedViewState();
    renderRows();
    renderFooter();
  }

  function readImportFile(){
    const file = els.importFile.files && els.importFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { els.importText.value = String(reader.result || ""); };
    reader.readAsText(file);
  }

  async function exportSelectedCsv(){
    const fields = visibleFields().filter((field) => field.type !== "notes");
    const response = await request("/internal/crm/leads/export", {
      method: "POST",
      body: {
        selection: selectionPayload(),
        fields: fields.map((field) => field.key)
      }
    });
    const blob = new Blob([response.csv || ""], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = response.filename || `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function parseCsv(text){
    const rows = [];
    const table = csvToArrays(text);
    if (table.length < 2) return rows;
    const headers = table[0].map((header) => normalizeHeader(header));
    for (const values of table.slice(1)) {
      const row = {};
      headers.forEach((header, index) => {
        if (header) row[header] = values[index] || "";
      });
      if (Object.values(row).some((value) => String(value).trim())) rows.push(row);
    }
    return rows;
  }

  function csvToArrays(text){
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];
      if (char === '"' && quoted && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === "," && !quoted) {
        row.push(cell);
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && next === "\n") i += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }
    row.push(cell);
    if (row.some((value) => value.trim())) rows.push(row);
    return rows;
  }

  function normalizeHeader(value){
    const raw = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const aliases = {
      name: "lead_name",
      lead: "lead_name",
      business: "company",
      business_name: "company",
      zip: "postal_code",
      zip_code: "postal_code",
      assigned: "assigned_to_email",
      assignee: "assigned_to_email",
      url: "website"
    };
    return aliases[raw] || raw;
  }

  async function request(path, options = {}){
    const response = await fetch(`${apiBase}${path}`, {
      method: options.method || "GET",
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "include"
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.success === false || json.ok === false) {
      throw new Error(json.message || json.error || `Request failed: ${response.status}`);
    }
    return json;
  }

  function sortBy(key){
    if (state.sort === key) state.dir = state.dir === "asc" ? "desc" : "asc";
    else {
      state.sort = key;
      state.dir = "asc";
    }
    saveViewState();
    loadLeads();
  }

  function selectVisible(){
    state.leads.forEach((lead) => setLeadSelected(String(lead.id), true));
    syncVisibleSelectionRows();
    renderFooter();
  }

  function selectFiltered(){
    state.selectionMode = "filtered";
    state.selected.clear();
    state.excluded.clear();
    state.selectionQuery = currentQueryPayload();
    state.selectionTotal = state.total;
    state.selectionSummary = { total: state.total, matching_current_filter: state.total, outside_current_filter: 0 };
    renderRows();
    renderFooter();
  }

  function visibleFields(){
    return state.fields.filter((field) => state.visible.has(field.key));
  }

  function openColumnsModal(){
    if (els.columnsModal && !els.columnsModal.open) els.columnsModal.showModal();
  }

  function placePanel(panel, anchor){
    const rect = anchor.getBoundingClientRect();
    panel.style.top = `${rect.bottom + 8}px`;
    panel.style.left = `${Math.min(rect.left, window.innerWidth - 320)}px`;
  }

  function placeNoteTooltip(panel, anchor){
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const reservedOpenColumn = 104;
    const width = Math.min(panel.offsetWidth || 360, window.innerWidth - (margin * 2));
    const height = panel.offsetHeight || 120;
    const maxLeft = window.innerWidth - width - reservedOpenColumn - margin;
    const left = Math.max(margin, Math.min(rect.left, maxLeft));
    let top = rect.bottom + margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - margin);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function closeFloatingPanels(event){
    if (event.target.closest(".floating-panel") || event.target.closest(".note-hover")) return;
    hide(els.notesPopover);
  }

  function beginDragSelection(id, index, event){
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      toggleRow(id, index, event);
      return;
    }
    const shouldSelect = !isLeadSelected(id);
    state.dragMode = shouldSelect ? "select" : "deselect";
    state.dragStartIndex = index;
    state.dragLastIndex = null;
    state.lastClicked = index;
    applyDragSelection(index);
  }

  function handleDragMouseMove(event){
    if (!state.dragMode) return;
    const node = document.elementFromPoint(event.clientX, event.clientY);
    const row = node && node.closest ? node.closest("#lead-body tr") : null;
    if (!row || row.dataset.index === undefined) return;
    handleDragToIndex(Number(row.dataset.index));
  }

  function handleDragToIndex(index){
    if (!state.dragMode || state.dragStartIndex === null || Number.isNaN(index) || index === state.dragLastIndex) return;
    applyDragSelection(index);
  }

  function applyDragSelection(index){
    const previous = state.dragLastIndex === null ? state.dragStartIndex : state.dragLastIndex;
    const start = Math.min(previous, index);
    const end = Math.max(previous, index);
    let changed = false;
    for (let i = start; i <= end; i += 1) {
      const lead = state.leads[i];
      if (lead && setLeadSelected(String(lead.id), state.dragMode === "select")) {
        syncRowSelection(i);
        changed = true;
      }
    }
    state.dragLastIndex = index;
    if (changed) queueFooterRender();
  }

  function endDragSelection(){
    state.dragMode = null;
    state.dragStartIndex = null;
    state.dragLastIndex = null;
  }

  function stopTableSelection(event){
    event.stopPropagation();
  }

  function toggleSelectedView(){
    if (selectedCount() === 0) return;
    state.selectedView = !state.selectedView;
    state.page = 1;
    updateSelectedViewState();
    loadLeads();
  }

  function updateSelectedViewState(){
    qs("#lead-app").classList.toggle("is-selected-view", state.selectedView);
    [els.leadSearch, els.leadStatus, els.leadRegion, els.leadAssigned, els.leadDisposition, els.leadPresence, els.leadImportedFrom, els.leadImportedTo, els.leadRefresh]
      .concat(Array.from(els.customTopbarFilters ? els.customTopbarFilters.querySelectorAll("input, select") : []))
      .filter(Boolean)
      .forEach((node) => {
        node.disabled = state.selectedView;
      });
  }

  function syncVisibleSelectionRows(){
    for (let i = 0; i < state.leads.length; i += 1) syncRowSelection(i);
    syncHeaderSelection();
  }

  function syncRowSelection(index){
    const row = els.leadBody.querySelector(`tr[data-index="${index}"]`);
    if (!row) return;
    const id = row.dataset.id || "";
    const selected = isLeadSelected(id);
    row.classList.toggle("is-selected", selected);
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.checked = selected;
  }

  function syncHeaderSelection(){
    const checkbox = els.leadHead.querySelector('input[type="checkbox"]');
    if (!checkbox) return;
    checkbox.checked = state.leads.length > 0 && state.leads.every((lead) => isLeadSelected(String(lead.id)));
  }

  function queueFooterRender(){
    if (state.footerFrame) return;
    state.footerFrame = requestAnimationFrame(() => {
      state.footerFrame = 0;
      syncHeaderSelection();
      renderFooter();
    });
  }

  function resetAndLoad(){
    state.page = 1;
    saveViewState();
    loadLeads();
  }

  function setBusy(busy){
    qs("#lead-app").setAttribute("aria-busy", busy ? "true" : "false");
    els.leadLoading.hidden = !busy;
  }

  function showLoadError(error){
    const message = error && error.message ? error.message : "Unable to load leads.";
    if (els.leadLoading) {
      els.leadLoading.hidden = false;
      els.leadLoading.innerHTML = `<div class="load-error"><strong>Unable to load leads.</strong><span>${escapeHtml(message)}</span><button id="retry-leads" class="primary-button" type="button">Retry</button></div>`;
      const retry = qs("#retry-leads");
      if (retry) retry.addEventListener("click", () => {
        els.leadLoading.textContent = "Loading leads...";
        loadLeads();
      });
    }
    const label = qs("#lead-scope-label");
    if (label) label.textContent = user.scopeLabel || (user.manager ? "Manager view: all leads" : `Assigned to ${user.email || "you"}`);
    console.error("Lead CRM load failed", error);
  }

  function qs(selector){ return document.querySelector(selector); }
  function qsAll(selector){ return Array.from(document.querySelectorAll(selector)); }
  function show(node){ node.hidden = false; }
  function hide(node){ if (node) node.hidden = true; }
  function camel(id){ return id.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()); }
  function debounce(fn, wait){ let id; return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), wait); }; }
  function safeJson(value, fallback){ try { return JSON.parse(value); } catch { return fallback; } }
  function labelize(value){ return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
  function trimText(value, length){ const text = String(value || ""); return text.length > length ? `${text.slice(0, length - 1)}...` : text; }
  function cssEscape(value){ return window.CSS && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
  function escapeHtml(value){ return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
  function escapeAttr(value){ return escapeHtml(value).replace(/"/g, "&quot;"); }
  function csvCell(value){ const raw = String(value || ""); return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw; }
  function formatDate(value){
    const n = Number(value || 0);
    if (!n) return "";
    const date = new Date(n > 100000000000 ? n : n * 1000);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
})();
