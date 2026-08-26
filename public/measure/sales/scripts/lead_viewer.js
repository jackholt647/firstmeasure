(function(){
  "use strict";

  function createLeadViewer(options){
    const apiBase = String(options.apiBase || "/v1").replace(/\/+$/, "");
    const user = options.user || {};
    const fields = () => typeof options.fields === "function" ? options.fields() : Array.isArray(options.fields) ? options.fields : [];
    const els = options.els;
    const state = {
      leadId: "",
      detail: null,
      saveTimers: new Map(),
      savingCount: 0
    };

    async function open(leadId){
      state.leadId = String(leadId || "");
      els.title.textContent = "Loading lead...";
      els.subtitle.textContent = "";
      els.body.innerHTML = `<div class="muted">Loading...</div>`;
      const detail = await request(`/internal/crm/leads/${encodeURIComponent(state.leadId)}/viewer`);
      render(detail);
    }

    function render(detail){
      state.detail = detail;
      const lead = detail.lead || {};
      state.leadId = String(lead.id || state.leadId);
      const contactNotesByContact = groupBy(detail.contact_notes || [], "contact_id");
      els.title.textContent = lead.company || lead.lead_name || "Lead";
      els.subtitle.textContent = [lead.phone, lead.email, lead.effective_assigned_to_email ? `Assigned to ${lead.effective_assigned_to_email}` : ""].filter(Boolean).join(" | ");
      els.body.innerHTML = `
        <section class="viewer-section">
          <h3>Lead <span id="viewer-save-state" class="viewer-save-state">Saved</span></h3>
          <div class="viewer-edit-grid">
            ${viewerInput("company", "Company", lead.company)}
            ${viewerInput("lead_name", "Lead Name", lead.lead_name)}
            ${viewerInput("status", "Status", lead.status)}
            ${viewerInput("phone", "Phone", lead.phone)}
            ${viewerInput("email", "Email", lead.email)}
            ${viewerInput("website", "Website", lead.website)}
            ${viewerInput("region", "Region", lead.region)}
            ${viewerInput("region_code", "Region Code", lead.region_code)}
            ${viewerInput("address", "Address", lead.address)}
            ${viewerInput("city", "City", lead.city)}
            ${viewerInput("state", "State", lead.state)}
            ${viewerInput("postal_code", "Postal", lead.postal_code)}
            ${customViewerInputs(lead)}
          </div>
          <div class="viewer-grid compact">
            ${viewerField("Most Recent Call", formatDate(lead.latest_call_at))}
            ${viewerField("Most Recent Export", formatDate(lead.latest_export_at))}
            ${viewerField("Import Date", formatDate(lead.imported_at))}
            ${viewerField("Updated", formatDate(lead.updated_at))}
          </div>
        </section>
        ${viewerQuickAdd("Note", "note-text", "Add note", "add-note")}
        ${viewerFollowupAdd()}
        ${viewerContacts(detail.contacts || [], contactNotesByContact)}
        ${viewerList("Notes", detail.notes || [], noteTemplate)}
        ${viewerList("Followups", detail.followups || [], followupTemplate)}
        ${viewerList("Activity", detail.activity || [], activityTemplate)}
      `;
      bindViewerActions();
      setSaveState("saved");
    }

    function bindViewerActions(){
      els.body.querySelectorAll("[data-lead-field]").forEach((input) => {
        input.addEventListener("input", () => queueLeadFieldSave(input));
        input.addEventListener("change", () => queueLeadFieldSave(input, 80));
      });
      els.body.querySelector('[data-action="add-note"]')?.addEventListener("click", addViewerNote);
      els.body.querySelector('[data-action="add-followup"]')?.addEventListener("click", addViewerFollowup);
      els.body.querySelectorAll('[data-action="save-contact"]').forEach((button) => button.addEventListener("click", saveViewerContact));
      els.body.querySelectorAll('[data-action="add-contact-note"]').forEach((button) => button.addEventListener("click", addViewerContactNote));
    }

    function queueLeadFieldSave(input, wait = 650){
      const key = input.dataset.leadField;
      if (!key) return;
      updateLocalLeadValue(key, input.value);
      setSaveState("pending");
      clearTimeout(state.saveTimers.get(key));
      state.saveTimers.set(key, setTimeout(() => saveLeadField(key, input.value), wait));
    }

    async function saveLeadField(key, value){
      state.saveTimers.delete(key);
      setSaveState("saving");
      const body = key.startsWith("custom_")
        ? { actor_email: user.email || "", custom_values: { [key.replace(/^custom_/, "")]: value } }
        : { actor_email: user.email || "", lead: { [key]: value } };
      try {
        const detail = await request(`/internal/crm/leads/${encodeURIComponent(state.leadId)}`, { method: "PATCH", body });
        mergeReturnedLead(detail.lead || {});
        if (typeof options.onLeadPatch === "function") options.onLeadPatch(detail.lead || {});
        setSaveState(state.saveTimers.size ? "pending" : "saved");
      } catch (error) {
        setSaveState("error");
        console.error("Lead autosave failed", error);
      }
    }

    function updateLocalLeadValue(key, value){
      if (!state.detail) return;
      state.detail.lead = state.detail.lead || {};
      state.detail.lead[key] = value;
      if (key === "company" || key === "lead_name") els.title.textContent = state.detail.lead.company || state.detail.lead.lead_name || "Lead";
      if (key === "phone" || key === "email") els.subtitle.textContent = [state.detail.lead.phone, state.detail.lead.email, state.detail.lead.effective_assigned_to_email ? `Assigned to ${state.detail.lead.effective_assigned_to_email}` : ""].filter(Boolean).join(" | ");
    }

    function mergeReturnedLead(lead){
      if (!state.detail) return;
      Object.assign(state.detail.lead, lead);
    }

    async function addViewerNote(){
      const textarea = els.body.querySelector("#note-text");
      const text = textarea ? textarea.value.trim() : "";
      if (!text) return;
      const detail = await request(`/internal/crm/leads/${encodeURIComponent(state.leadId)}/notes`, {
        method: "POST",
        body: { actor_email: user.email || "", note_text: text }
      });
      render(detail);
      if (typeof options.onActivityChange === "function") options.onActivityChange(detail.lead || {});
    }

    async function addViewerFollowup(){
      const title = els.body.querySelector("#followup-title")?.value.trim() || "";
      const body = els.body.querySelector("#followup-body")?.value.trim() || "";
      const due = els.body.querySelector("#followup-due")?.value || "";
      if (!title && !body) return;
      const detail = await request(`/internal/crm/leads/${encodeURIComponent(state.leadId)}/followups`, {
        method: "POST",
        body: { actor_email: user.email || "", title, body, due_at: due }
      });
      render(detail);
      if (typeof options.onActivityChange === "function") options.onActivityChange(detail.lead || {});
    }

    async function saveViewerContact(event){
      const item = event.target.closest("[data-contact-id]");
      if (!item) return;
      const contact = {};
      item.querySelectorAll("[data-contact-field]").forEach((input) => {
        contact[input.dataset.contactField] = input.value;
      });
      setSaveState("saving");
      const detail = await request(`/internal/crm/leads/${encodeURIComponent(state.leadId)}/contacts/${encodeURIComponent(item.dataset.contactId)}`, {
        method: "PATCH",
        body: { actor_email: user.email || "", contact }
      });
      mergeReturnedLead(detail.lead || {});
      setSaveState("saved");
      if (typeof options.onLeadPatch === "function") options.onLeadPatch(detail.lead || {});
    }

    async function addViewerContactNote(event){
      const item = event.target.closest("[data-contact-id]");
      const input = item && item.querySelector("[data-contact-note]");
      const text = input ? input.value.trim() : "";
      if (!item || !text) return;
      const detail = await request(`/internal/crm/leads/${encodeURIComponent(state.leadId)}/contacts/${encodeURIComponent(item.dataset.contactId)}/notes`, {
        method: "POST",
        body: { actor_email: user.email || "", note_text: text }
      });
      render(detail);
      if (typeof options.onActivityChange === "function") options.onActivityChange(detail.lead || {});
    }

    async function request(path, requestOptions = {}){
      const response = await fetch(`${apiBase}${path}`, {
        method: requestOptions.method || "GET",
        headers: { Accept: "application/json", ...(requestOptions.body ? { "Content-Type": "application/json" } : {}) },
        body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
        credentials: "include"
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.success === false || json.ok === false) {
        throw new Error(json.message || json.error || `Request failed: ${response.status}`);
      }
      return json;
    }

    function setSaveState(status){
      const node = els.body.querySelector("#viewer-save-state");
      if (!node) return;
      node.className = `viewer-save-state is-${status}`;
      node.textContent = status === "saving" ? "Saving..." : status === "pending" ? "Unsaved" : status === "error" ? "Save failed" : "Saved";
    }

    function viewerField(label, value){
      return `<div class="viewer-field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "")}</strong></div>`;
    }

    function viewerInput(name, label, value){
      return `<label class="viewer-input"><span>${escapeHtml(label)}</span><input data-lead-field="${escapeAttr(name)}" value="${escapeAttr(value || "")}"></label>`;
    }

    function customViewerInputs(lead){
      return fields().filter((field) => field.custom).map((field) => viewerInput(field.key, field.label, lead[field.key] || "")).join("");
    }

    function viewerQuickAdd(title, id, placeholder, action){
      return `<section class="viewer-section viewer-add-row"><h3>${escapeHtml(title)}</h3><textarea id="${id}" placeholder="${escapeAttr(placeholder)}"></textarea><button class="primary-button" type="button" data-action="${escapeAttr(action)}">Add</button></section>`;
    }

    function viewerFollowupAdd(){
      return `<section class="viewer-section viewer-add-row"><h3>Follow-up</h3><input id="followup-title" placeholder="Title"><input id="followup-due" type="date"><textarea id="followup-body" placeholder="Details"></textarea><button class="primary-button" type="button" data-action="add-followup">Add</button></section>`;
    }

    function viewerContacts(contacts, notesByContact){
      return `<section class="viewer-section"><h3>Contacts <span>${contacts.length.toLocaleString()}</span></h3><div class="viewer-list">${contacts.length ? contacts.map((contact) => contactEditTemplate(contact, notesByContact[String(contact.id)] || [])).join("") : `<div class="muted">None yet.</div>`}</div></section>`;
    }

    function viewerList(title, rows, template){
      return `<section class="viewer-section"><h3>${escapeHtml(title)} <span>${Number(rows.length || 0).toLocaleString()}</span></h3><div class="viewer-list">${rows.length ? rows.map(template).join("") : `<div class="muted">None yet.</div>`}</div></section>`;
    }

    function contactEditTemplate(contact, notes){
      return `<article class="viewer-item contact-edit" data-contact-id="${escapeAttr(contact.id)}">
        <div class="contact-edit-grid">
          ${contactInput("full_name", "Name", contact.full_name)}
          ${contactInput("title", "Title", contact.title)}
          ${contactInput("email", "Email", contact.email)}
          ${contactInput("phone", "Phone", contact.phone)}
        </div>
        <textarea data-contact-field="notes" placeholder="Contact notes">${escapeHtml(contact.notes || "")}</textarea>
        <div class="viewer-inline-actions"><button class="mini-button" type="button" data-action="save-contact">Save contact</button></div>
        <div class="viewer-list compact-list">${notes.slice(0, 3).map(noteTemplate).join("")}</div>
        <div class="viewer-inline-actions"><input data-contact-note placeholder="Add contact note"><button class="mini-button" type="button" data-action="add-contact-note">Add note</button></div>
      </article>`;
    }

    function contactInput(name, label, value){
      return `<label class="viewer-input"><span>${escapeHtml(label)}</span><input data-contact-field="${escapeAttr(name)}" value="${escapeAttr(value || "")}"></label>`;
    }

    function noteTemplate(note){
      return `<article class="viewer-item"><strong>${escapeHtml(formatDate(note.created_at))}</strong><span>${escapeHtml(note.owner_email || "")}</span><p>${escapeHtml(note.note_text || "")}</p></article>`;
    }

    function followupTemplate(followup){
      return `<article class="viewer-item"><strong>${escapeHtml(followup.title || labelize(followup.status) || "Follow-up")}</strong><span>${escapeHtml([formatDate(followup.due_at), followup.owner_email, followup.priority].filter(Boolean).join(" | "))}</span>${followup.body ? `<p>${escapeHtml(followup.body)}</p>` : ""}</article>`;
    }

    function activityTemplate(activity){
      return `<article class="viewer-item"><strong>${escapeHtml(activity.subject || labelize(activity.activity_type) || "Activity")}</strong><span>${escapeHtml([formatDate(activity.happened_at), activity.owner_email, activity.direction].filter(Boolean).join(" | "))}</span>${activity.body_text ? `<p>${escapeHtml(activity.body_text)}</p>` : ""}</article>`;
    }

    return { open, render, request };
  }

  window.FirstMeasureLeadViewer = { create: createLeadViewer };

  const cfg = window.LEAD_VIEWER_CFG || null;
  if (cfg) document.addEventListener("DOMContentLoaded", async () => {
    const body = document.querySelector("#lead-viewer-body");
    const apiBase = String(cfg.apiBase || "/v1").replace(/\/+$/, "");
    if (!cfg.leadId) {
      body.innerHTML = `<div class="load-error"><strong>No lead selected.</strong><span>Add ?id=lead_id to the URL.</span></div>`;
      return;
    }
    try {
      body.innerHTML = `<div class="muted">Loading...</div>`;
      const fieldsResponse = await fetch(`${apiBase}/internal/crm/leads/fields`, { headers: { Accept: "application/json" }, credentials: "include" }).then((response) => response.json());
      const viewer = createLeadViewer({
        apiBase,
        user: cfg.user || {},
        fields: fieldsResponse.fields || [],
        els: {
          title: document.querySelector("#viewer-title"),
          subtitle: document.querySelector("#viewer-subtitle"),
          body
        }
      });
      await viewer.open(cfg.leadId);
    } catch (error) {
      body.innerHTML = `<div class="load-error"><strong>Unable to load lead.</strong><span>${escapeHtml(error.message || "Request failed.")}</span></div>`;
    }
  });

  function groupBy(rows, key){ return rows.reduce((out, row) => { const value = String(row[key] || ""); (out[value] ||= []).push(row); return out; }, {}); }
  function labelize(value){ return String(value || "").replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
  function escapeHtml(value){ return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
  function escapeAttr(value){ return escapeHtml(value).replace(/"/g, "&quot;"); }
  function formatDate(value){
    const n = Number(value || 0);
    if (!n) return "";
    const date = new Date(n > 100000000000 ? n : n * 1000);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
})();
