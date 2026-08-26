(function () {
  const PANEL_ID = "firstmate-sales-panel";
  const STYLE_ID = "firstmate-sales-style";
  const DISPO_ID = "firstmate-disposition";
  const PANEL_HEIGHT = 220;
  const TEMPLATES = [
    { id: "gatekeeper", label: "Gatekeeper" },
    { id: "basic", label: "Basic" },
    { id: "cold-decision-maker", label: "Cold DM" },
    { id: "warm-decision-maker", label: "Warm DM" }
  ];
  const state = {
    leadId: "",
    leadDetail: null,
    fetchingLeadId: "",
    bootTimer: 0,
    selectedDispo: "",
    selectedContactType: "",
    signupEmail: "",
    firstName: "",
    lastName: "",
    contactId: "",
    gmailOpen: false,
    lastEmailSent: null,
    gmailStatusLeadId: "",
    gmailStatusTimer: 0,
    fetchingGmailStatus: false
  };
  const DISPOSITIONS = [
    {
      id: "not-real-disconnected",
      label: "Not real company / disconnected",
      nativeHints: ["Disconnected Number", "Wrong Number", "Unqualified Lead"],
      mode: "no-email"
    },
    {
      id: "no-answer",
      label: "No answer",
      nativeHints: ["No Answer", "Needs Follow-Up"],
      mode: "no-email"
    },
    {
      id: "no-email",
      label: "No email",
      nativeHints: ["Needs Follow-Up", "Not Interested"],
      mode: "no-email"
    },
    {
      id: "email-sent-verified",
      label: "Email Sent - Verified Receipt",
      nativeHints: ["Information Sent", "Qualified Lead"],
      asksContactType: true,
      mode: "email-sent"
    },
    {
      id: "email-sent-unverified",
      label: "Email Sent - Unverified Receipt",
      nativeHints: ["Information Sent", "Needs Follow-Up"],
      asksContactType: true,
      mode: "email-sent"
    },
    {
      id: "signed-up",
      label: "Signed Up",
      nativeHints: ["Sale Closed", "Interested - Appointment Set"],
      asksContactType: true,
      asksEmail: true,
      mode: "email-sent"
    }
  ];

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      body.firstmate-sales-active .be-left-sidebar {
        height: calc(100vh - ${PANEL_HEIGHT}px) !important;
        max-height: calc(100vh - ${PANEL_HEIGHT}px) !important;
        overflow: auto !important;
      }

      @media (min-width: 992px) {
        body.firstmate-sales-active .col-md-2 {
          width: 14% !important;
        }
      }

      body.firstmate-sales-active .be-fixed-sidebar .be-left-sidebar,
      body.firstmate-sales-active .be-fixed-sidebar.be-left-sidebar,
      body.firstmate-sales-active .be-fixed-sidebar .be-left-sidebar.be-fixed-sidebar .be-left-sidebar {
        height: calc(100vh - ${PANEL_HEIGHT}px) !important;
        max-height: calc(100vh - ${PANEL_HEIGHT}px) !important;
        overflow: auto !important;
      }

      #${PANEL_ID} {
        position: fixed;
        left: 0;
        bottom: 0;
        z-index: 2147483647;
        width: var(--firstmate-sidebar-width, 240px);
        height: ${PANEL_HEIGHT}px;
        box-sizing: border-box;
        background: #111111;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        border-right: 1px solid rgba(255, 255, 255, 0.1);
        color: #f9fafb;
        font-family: Inter, Arial, sans-serif;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-shadow: 0 -8px 24px rgba(17, 24, 39, 0.18);
      }

      #${PANEL_ID} .firstmate-icon-row {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 24px;
      }

      #${PANEL_ID} .firstmate-company {
        color: #fff;
        font-size: 12px;
        font-weight: 800;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${PANEL_ID} .firstmate-icon {
        width: 22px;
        height: 22px;
        object-fit: contain;
      }

      #${PANEL_ID} .firstmate-status {
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        color: #cbd5e1;
        font-size: 11px;
        line-height: 1.35;
        margin-top: auto;
        min-height: 44px;
        overflow: hidden;
        padding-top: 7px;
      }

      #${PANEL_ID} button {
        appearance: none;
        border: 0;
        border-radius: 6px;
        background: #db0000;
        color: #fff;
        cursor: pointer;
        font-size: 11px;
        font-weight: 700;
        min-height: 27px;
        padding: 5px 8px;
        text-align: left;
      }

      #${PANEL_ID} button:hover {
        background: #b80000;
      }

      #${PANEL_ID} button:disabled {
        cursor: default;
        opacity: 0.65;
      }

      #${PANEL_ID} .firstmate-template-buttons {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 5px;
      }

      #${PANEL_ID} .firstmate-name-grid {
        display: grid;
        gap: 5px;
        grid-template-columns: 1fr 1fr;
      }

      #${PANEL_ID} .firstmate-name-grid input {
        background: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 6px;
        box-sizing: border-box;
        color: #111827;
        font: 700 11px Inter, Arial, sans-serif;
        min-height: 27px;
        padding: 5px 7px;
        width: 100%;
      }

      body.firstmate-sales-active #call-end-options {
        display: none !important;
      }

      body.firstmate-sales-active #disposition-col > .panel {
        display: none !important;
      }

      body.firstmate-sales-active #disposition-col.firstmate-dispo-active {
        float: none !important;
        margin-left: 0 !important;
        width: 100% !important;
      }

      #${DISPO_ID} {
        box-sizing: border-box;
        color: #111827;
        font-family: Montserrat, 'Montserrat-Regular', Inter, Arial, sans-serif;
        margin: 0 auto;
        max-width: 620px;
        padding: 10px 0 18px;
      }

      #${DISPO_ID} .firstmate-dispo-card {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-top: 5px solid #db0000;
        border-radius: 8px;
        box-shadow: 0 18px 45px rgba(15, 23, 42, 0.12);
        padding: 18px;
      }

      #${DISPO_ID} .firstmate-dispo-title {
        align-items: center;
        display: flex;
        gap: 10px;
        margin-bottom: 14px;
      }

      #${DISPO_ID} .firstmate-dispo-title img {
        height: 26px;
        width: 26px;
      }

      #${DISPO_ID} h2 {
        font-size: 18px;
        font-weight: 800;
        margin: 0;
      }

      #${DISPO_ID} h3 {
        color: #374151;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0;
        margin: 16px 0 8px;
      }

      #${DISPO_ID} .firstmate-dispo-options {
        display: grid;
        gap: 8px;
      }

      #${DISPO_ID} .firstmate-dispo-option,
      #${DISPO_ID} .firstmate-dispo-submit {
        appearance: none;
        align-items: center;
        background: #ffffff;
        border: 1px solid #d1d5db;
        border-radius: 7px;
        box-sizing: border-box;
        color: #111827;
        cursor: pointer;
        display: flex;
        font-family: inherit;
        font-size: 13px;
        font-weight: 800;
        justify-content: space-between;
        min-height: 40px;
        padding: 10px 12px;
        text-align: left;
        width: 100%;
      }

      #${DISPO_ID} .firstmate-dispo-option:hover,
      #${DISPO_ID} .firstmate-dispo-submit:hover {
        border-color: #db0000;
      }

      #${DISPO_ID} .firstmate-dispo-option.is-selected,
      #${DISPO_ID} .firstmate-dispo-submit {
        background: #db0000;
        border-color: #db0000;
        color: #ffffff;
      }

      #${DISPO_ID} .firstmate-dispo-followup {
        border-top: 1px solid #e5e7eb;
        margin-top: 14px;
        padding-top: 2px;
      }

      #${DISPO_ID} .firstmate-dispo-split {
        display: grid;
        gap: 8px;
        grid-template-columns: 1fr 1fr;
      }

      #${DISPO_ID} .firstmate-dispo-email {
        border: 1px solid #d1d5db;
        border-radius: 7px;
        box-sizing: border-box;
        font-family: inherit;
        font-size: 13px;
        min-height: 40px;
        padding: 9px 10px;
        width: 100%;
      }

      #${DISPO_ID} .firstmate-dispo-message {
        color: #6b7280;
        font-size: 12px;
        line-height: 1.4;
        margin-top: 10px;
        min-height: 17px;
      }

      #${DISPO_ID} .firstmate-dispo-gmail {
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 7px;
        color: #374151;
        font-size: 12px;
        line-height: 1.35;
        margin-bottom: 12px;
        padding: 9px 10px;
      }

      @media (max-width: 720px) {
        #${DISPO_ID} .firstmate-dispo-split {
          grid-template-columns: 1fr;
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function getText(selector) {
    const node = document.querySelector(selector);
    return node ? String(node.textContent || "").trim() : "";
  }

  function findEmailInPage() {
    const mailto = document.querySelector('a[href^="mailto:"]');
    if (mailto) return mailto.getAttribute("href").replace(/^mailto:/i, "").split("?")[0].trim();

    const text = document.body ? document.body.innerText : "";
    const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0] : "";
  }

  function findLeadIdInPage() {
    const customRows = Array.from(document.querySelectorAll(".row.prop.custom-fields"));
    for (const row of customRows) {
      const label = String(row.querySelector(".prop-head")?.textContent || "").trim().toLowerCase();
      if (label !== "fm lead id") continue;
      const value = String(row.querySelector(".prop-value, .prop-add")?.textContent || "").trim();
      if (value) return value;
    }

    const text = document.body ? document.body.innerText : "";
    const patterns = [
      /FM\s*Lead\s*ID\s*[:#]?\s*(FM-[a-zA-Z0-9_.:-]+)/i,
      /FirstMate\s*Lead\s*ID\s*[:#]?\s*(FM-[a-zA-Z0-9_.:-]+)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1].trim();
    }
    return "";
  }

  function collectLeadContext() {
    const leadName =
      getText("[data-testid*='name' i]") ||
      getText(".lead-name") ||
      getText(".contact-name") ||
      "";
    const fetchedLead = state.leadDetail?.lead || {};
    const name = leadName || String(fetchedLead.lead_name || fetchedLead.name || "");
    const nameParts = name.split(/\s+/).filter(Boolean);
    const firstName = String(state.firstName || fetchedLead.first_name || nameParts[0] || "");
    const lastName = String(state.lastName || fetchedLead.last_name || nameParts.slice(1).join(" ") || "");
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const primaryContact = {
      id: String(state.contactId || ""),
      fullName,
      firstName,
      lastName,
      email: ""
    };
    return {
      to: "",
      lead: {
        id: state.leadId || findLeadIdInPage(),
        crmId: String(fetchedLead.id || state.leadDetail?.crm_lead_id || ""),
        fmLeadId: String(fetchedLead.fm_lead_id || state.leadId || ""),
        name,
        company: String(fetchedLead.company || ""),
        email: String(fetchedLead.email || ""),
        phone: String(fetchedLead.phone || getText('a[href^="tel:"]') || ""),
        address: String(fetchedLead.address || ""),
        website: String(fetchedLead.website || ""),
        firstName,
        lastName,
        primaryContact,
        contactId: primaryContact.id,
        raw: fetchedLead,
        detail: state.leadDetail || null,
        contacts: state.leadDetail?.contacts || [],
        notes: state.leadDetail?.notes || [],
        followups: state.leadDetail?.followups || [],
        dialEvents: state.leadDetail?.dial_events || [],
        pageTitle: document.title,
        pageUrl: location.href
      }
    };
  }

  function splitContactName(contact) {
    const fullName = String(contact?.full_name || contact?.fullName || contact?.name || "").trim();
    const parts = fullName.split(/\s+/).filter(Boolean);
    return {
      firstName: String(contact?.first_name || contact?.firstName || parts[0] || ""),
      lastName: String(contact?.last_name || contact?.lastName || parts.slice(1).join(" ") || "")
    };
  }

  function primaryContactFromLeadDetail(detail = state.leadDetail) {
    const contacts = Array.isArray(detail?.contacts) ? detail.contacts : [];
    return contacts[0] || null;
  }

  function syncContactFieldsFromLead(detail = state.leadDetail) {
    const contact = primaryContactFromLeadDetail(detail);
    if (!contact) {
      state.contactId = "";
      state.firstName = "";
      state.lastName = "";
      renderContactInputs();
      return;
    }
    const names = splitContactName(contact);
    state.contactId = String(contact.id || contact.contact_id || "");
    state.firstName = names.firstName;
    state.lastName = names.lastName;
    renderContactInputs();
  }

  function renderContactInputs() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const first = panel.querySelector("[data-firstmate-first-name]");
    const last = panel.querySelector("[data-firstmate-last-name]");
    if (first && first.value !== state.firstName) first.value = state.firstName;
    if (last && last.value !== state.lastName) last.value = state.lastName;
  }

  function leadCompanyName() {
    return String(state.leadDetail?.lead?.company || "").trim();
  }

  function renderLeadInfo() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const company = panel.querySelector("[data-firstmate-company]");
    company.textContent = leadCompanyName() || (state.leadId ? state.leadId : "FirstMate");
  }

  function setPanelStatus(message) {
    const panel = document.getElementById(PANEL_ID);
    const status = panel?.querySelector("[data-firstmate-status]");
    if (status) status.textContent = message || "";
  }

  function isVisible(node) {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function nativeDispositionScreen() {
    const disposition = document.getElementById("disposition-col");
    if (!disposition || !isVisible(disposition)) return null;
    if (!document.getElementById("list-dispositions") || !document.getElementById("disposition-btn")) return null;
    return disposition;
  }

  function dispositionById(id) {
    return DISPOSITIONS.find((item) => item.id === id) || null;
  }

  function emailWasSentForActiveLead() {
    return Boolean(state.leadId && state.lastEmailSent && String(state.lastEmailSent.leadId || "") === state.leadId);
  }

  function visibleDispositions() {
    const mode = emailWasSentForActiveLead() ? "email-sent" : "no-email";
    return DISPOSITIONS.filter((item) => item.mode === mode);
  }

  function gmailDispositionStatusText() {
    if (!state.gmailOpen) return "Gmail is not connected, so this call is being treated as no email sent.";
    if (!emailWasSentForActiveLead()) return "Gmail connected. No tracked email has been sent for this lead.";
    const recipients = state.lastEmailSent?.recipients?.all
      || [...(state.lastEmailSent?.to || []), ...(state.lastEmailSent?.cc || []), ...(state.lastEmailSent?.bcc || [])];
    return `Gmail connected. Email sent${recipients?.length ? ` to ${recipients.join(", ")}` : ""}.`;
  }

  function setNativeDisposition(dispo) {
    const select = document.getElementById("list-dispositions");
    if (!select || !dispo) return;
    const options = Array.from(select.options || []);
    const match = dispo.nativeHints
      .map((hint) => options.find((option) => String(option.textContent || "").trim().toLowerCase() === hint.toLowerCase()))
      .find(Boolean)
      || options.find((option) => option.value && option.value !== "none");
    if (!match) return;
    select.value = match.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function updateNativeNotes(dispo, extra = {}) {
    const note = document.getElementById("call-note");
    if (!note || !dispo) return;
    const existing = String(note.value || "").trim();
    const lines = [
      `FirstMate disposition: ${dispo.label}`,
      extra.contactType ? `Reached: ${extra.contactType}` : "",
      extra.signupEmail ? `Signup email: ${extra.signupEmail}` : "",
      extra.emailSent ? "Gmail email sent: yes" : "Gmail email sent: no",
      state.leadId ? `Lead ID: ${state.leadId}` : "",
      leadCompanyName() ? `Company: ${leadCompanyName()}` : ""
    ].filter(Boolean);
    note.value = [existing, lines.join("\n")].filter(Boolean).join("\n\n");
    note.dispatchEvent(new Event("input", { bubbles: true }));
    note.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clickNativeSave() {
    const button = document.getElementById("disposition-btn");
    if (button) button.click();
  }

  function resetDispositionState() {
    state.selectedDispo = "";
    state.selectedContactType = "";
    state.signupEmail = "";
  }

  async function fetchActiveLead(leadId) {
    if (!leadId || state.fetchingLeadId === leadId) return;
    state.fetchingLeadId = leadId;
    try {
      const response = await chrome.runtime.sendMessage({ type: "FIRSTMATE_FETCH_LEAD", leadId });
      if (response?.ok && response.data?.lead) {
        state.leadDetail = response.data;
      } else {
        state.leadDetail = { lead: { id: leadId, company: "" } };
      }
      syncContactFieldsFromLead(state.leadDetail);
      renderLeadInfo();
      chrome.runtime.sendMessage({
        type: "FIRSTMATE_ACTIVE_LEAD_CHANGED",
        payload: {
          leadId,
          lead: collectLeadContext().lead,
          openBlankCompose: true
        }
      }).catch(() => {});
      refreshGmailStatus(true);
    } catch (error) {
      state.leadDetail = { lead: { id: leadId, company: "", error: error.message } };
      renderLeadInfo();
    } finally {
      state.fetchingLeadId = "";
    }
  }

  function scrubLeadId() {
    const nextLeadId = findLeadIdInPage();
    if (!nextLeadId || nextLeadId === state.leadId) return;
    state.leadId = nextLeadId;
    state.leadDetail = null;
    state.lastEmailSent = null;
    state.gmailStatusLeadId = "";
    state.contactId = "";
    state.firstName = "";
    state.lastName = "";
    renderContactInputs();
    renderLeadInfo();
    fetchActiveLead(nextLeadId);
  }

  async function savePrimaryContactIfNeeded() {
    const payload = collectLeadContext();
    const contact = payload.lead.primaryContact || {};
    if (!payload.lead.crmId && !payload.lead.id) return { ok: true, skipped: true };
    if (!contact.firstName && !contact.lastName) return { ok: true, skipped: true };
    const response = await chrome.runtime.sendMessage({
      type: "FIRSTMATE_SAVE_PRIMARY_CONTACT",
      payload: {
        leadId: payload.lead.crmId || payload.lead.id,
        fmLeadId: payload.lead.fmLeadId || payload.lead.id,
        contactId: contact.id || "",
        firstName: contact.firstName || "",
        lastName: contact.lastName || "",
        email: ""
      }
    });
    if (response?.ok && response.contact) {
      const names = splitContactName(response.contact);
      state.contactId = String(response.contact.id || response.contact.contact_id || state.contactId || "");
      state.firstName = names.firstName || state.firstName;
      state.lastName = names.lastName || state.lastName;
      const contacts = Array.isArray(state.leadDetail?.contacts) ? state.leadDetail.contacts : [];
      state.leadDetail = {
        ...(state.leadDetail || {}),
        contacts: [response.contact, ...contacts.filter((item) => String(item?.id || "") !== String(response.contact.id || ""))]
      };
      renderContactInputs();
    }
    return response || { ok: false, error: "No contact save response" };
  }

  async function refreshGmailStatus(force = false) {
    if (!state.leadId || state.fetchingGmailStatus) return;
    const now = Date.now();
    if (!force && state.gmailStatusLeadId === state.leadId && now - state.gmailStatusTimer < 1000) return;
    state.fetchingGmailStatus = true;
    state.gmailStatusTimer = now;
    state.gmailStatusLeadId = state.leadId;
    try {
      const response = await chrome.runtime.sendMessage({ type: "FIRSTMATE_GET_GMAIL_STATUS", leadId: state.leadId });
      if (response?.ok) {
        state.gmailOpen = Boolean(response.gmailOpen);
        state.lastEmailSent = response.lastEmailSent || null;
      }
    } catch (error) {
      state.gmailOpen = false;
      state.lastEmailSent = null;
    } finally {
      state.fetchingGmailStatus = false;
    }
  }

  function syncPanelGeometry() {
    const sidebar = document.querySelector(".be-left-sidebar") || document.querySelector(".be-fixed-sidebar");
    const rect = sidebar ? sidebar.getBoundingClientRect() : null;
    const width = rect && rect.width > 80 ? rect.width : 240;
    document.documentElement.style.setProperty("--firstmate-sidebar-width", `${Math.round(width)}px`);
  }

  function renderCustomDisposition() {
    const host = nativeDispositionScreen();
    if (!host) {
      document.body?.classList.remove("firstmate-dispo-visible");
      document.getElementById(DISPO_ID)?.remove();
      resetDispositionState();
      return;
    }

    document.body.classList.add("firstmate-dispo-visible");
    host.classList.add("firstmate-dispo-active");
    refreshGmailStatus();

    let node = document.getElementById(DISPO_ID);
    if (!node) {
      node = document.createElement("section");
      node.id = DISPO_ID;
      host.appendChild(node);
    }

    const selected = dispositionById(state.selectedDispo);
    const needsContactType = Boolean(selected?.asksContactType);
    const needsEmail = Boolean(selected?.asksEmail);
    const dispos = visibleDispositions();
    if (selected && !dispos.some((dispo) => dispo.id === selected.id)) {
      resetDispositionState();
      renderCustomDisposition();
      return;
    }
    node.innerHTML = `
      <div class="firstmate-dispo-card">
        <div class="firstmate-dispo-title">
          <img alt="" src="${chrome.runtime.getURL("assets/icon_red.png")}">
          <h2>Call Disposition</h2>
        </div>
        <div class="firstmate-dispo-gmail">${escapeHtml(gmailDispositionStatusText())}</div>
        <h3>What was the dispo?</h3>
        <div class="firstmate-dispo-options">
          ${dispos.map((dispo) => `
            <button type="button" class="firstmate-dispo-option ${state.selectedDispo === dispo.id ? "is-selected" : ""}" data-firstmate-dispo="${dispo.id}">
              <span>${escapeHtml(dispo.label)}</span>
            </button>
          `).join("")}
        </div>
        ${needsContactType ? `
          <div class="firstmate-dispo-followup">
            <h3>Did we end on a decision maker or a gatekeeper?</h3>
            <div class="firstmate-dispo-split">
              <button type="button" class="firstmate-dispo-option ${state.selectedContactType === "Decision maker" ? "is-selected" : ""}" data-firstmate-contact-type="Decision maker">Decision maker</button>
              <button type="button" class="firstmate-dispo-option ${state.selectedContactType === "Gatekeeper" ? "is-selected" : ""}" data-firstmate-contact-type="Gatekeeper">Gatekeeper</button>
            </div>
          </div>
        ` : ""}
        ${needsEmail ? `
          <div class="firstmate-dispo-followup">
            <h3>What email did they use?</h3>
            <input class="firstmate-dispo-email" data-firstmate-signup-email type="email" spellcheck="false" value="${escapeAttribute(state.signupEmail)}" placeholder="customer@company.com">
            <button type="button" class="firstmate-dispo-submit" data-firstmate-submit-signup>Save & next call</button>
          </div>
        ` : ""}
        <div class="firstmate-dispo-message" data-firstmate-dispo-message></div>
      </div>
    `;

    node.querySelectorAll("[data-firstmate-dispo]").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedDispo = button.dataset.firstmateDispo || "";
        state.selectedContactType = "";
        const dispo = dispositionById(state.selectedDispo);
        if (!dispo?.asksContactType && !dispo?.asksEmail) {
          saveFirstMateDisposition();
          return;
        }
        renderCustomDisposition();
      });
    });

    node.querySelectorAll("[data-firstmate-contact-type]").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedContactType = button.dataset.firstmateContactType || "";
        saveFirstMateDisposition();
      });
    });

    const emailInput = node.querySelector("[data-firstmate-signup-email]");
    if (emailInput) {
      emailInput.addEventListener("input", () => {
        state.signupEmail = emailInput.value.trim();
      });
    }
    node.querySelector("[data-firstmate-submit-signup]")?.addEventListener("click", () => {
      state.signupEmail = node.querySelector("[data-firstmate-signup-email]")?.value.trim() || "";
      saveFirstMateDisposition();
    });
  }

  function setDispositionMessage(message) {
    const node = document.querySelector(`#${DISPO_ID} [data-firstmate-dispo-message]`);
    if (node) node.textContent = message || "";
  }

  function saveFirstMateDisposition() {
    const dispo = dispositionById(state.selectedDispo);
    if (!dispo) return;
    if (dispo.asksContactType && !state.selectedContactType) {
      setDispositionMessage("Choose decision maker or gatekeeper.");
      return;
    }
    if (dispo.asksEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.signupEmail)) {
      setDispositionMessage("Enter the signup email before saving.");
      return;
    }
    setNativeDisposition(dispo);
    updateNativeNotes(dispo, {
      contactType: state.selectedContactType,
      signupEmail: state.signupEmail,
      emailSent: emailWasSentForActiveLead()
    });
    chrome.runtime.sendMessage({
      type: "FIRSTMATE_GMAIL_EVENT",
      event: {
        action: "sales_disposition",
        at: new Date().toISOString(),
        dispositionId: dispo.id,
        disposition: dispo.label,
        contactType: state.selectedContactType,
        signupEmail: state.signupEmail,
        emailSent: emailWasSentForActiveLead(),
        emailEvent: state.lastEmailSent || null,
        lead: collectLeadContext().lead
      }
    }).catch(() => {});
    setDispositionMessage("Saved. Moving to the next call...");
    window.setTimeout(clickNativeSave, 80);
  }

  function renderPanel() {
    document.body.classList.add("firstmate-sales-active");
    syncPanelGeometry();
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="firstmate-icon-row">
        <img class="firstmate-icon" alt="FirstMate" src="${chrome.runtime.getURL("assets/icon_red.png")}">
        <span class="firstmate-company" data-firstmate-company>FirstMate</span>
      </div>
      <div class="firstmate-name-grid">
        <input data-firstmate-first-name autocomplete="off" spellcheck="false" placeholder="First" value="${escapeAttribute(state.firstName)}">
        <input data-firstmate-last-name autocomplete="off" spellcheck="false" placeholder="Last" value="${escapeAttribute(state.lastName)}">
      </div>
      <div class="firstmate-template-buttons">
        ${TEMPLATES.map((template) => `<button type="button" data-firstmate-template="${template.id}">${template.label}</button>`).join("")}
      </div>
      <div class="firstmate-status" data-firstmate-status></div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector("[data-firstmate-first-name]")?.addEventListener("input", (event) => {
      state.firstName = event.target.value.trim();
    });
    panel.querySelector("[data-firstmate-last-name]")?.addEventListener("input", (event) => {
      state.lastName = event.target.value.trim();
    });

    panel.querySelectorAll("[data-firstmate-template]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      renderLeadInfo();
      try {
        const payload = collectLeadContext();
        payload.templateId = button.dataset.firstmateTemplate || "";
        setPanelStatus("Saving primary contact...");
        const contactSave = await savePrimaryContactIfNeeded();
        if (contactSave && contactSave.ok === false) {
          throw new Error(contactSave.error || contactSave.data?.error || "Could not save primary contact");
        }
        const savedPayload = collectLeadContext();
        savedPayload.templateId = payload.templateId;
        setPanelStatus(`Sending ${button.textContent.trim()} to Gmail...`);
        const response = await chrome.runtime.sendMessage({
          type: "FIRSTMATE_SEND_EMAIL_REQUEST",
          payload: savedPayload
        });
        const gmailOk = response?.gmail?.some((item) => item.ok && item.response?.ok);
        const gmailError = response?.gmail?.find((item) => item.response?.error || item.error);
        setPanelStatus(gmailOk
          ? `Drafted ${button.textContent.trim()}`
          : (gmailError?.response?.error || gmailError?.error || "Open Gmail first"));
      } catch (error) {
        setPanelStatus(error.message || "Request failed");
      } finally {
        window.setTimeout(() => {
          button.disabled = false;
        }, 800);
      }
    }));

    return panel;
  }

  function boot() {
    injectStyles();
    if (document.body) {
      renderPanel();
      scrubLeadId();
      renderCustomDisposition();
    }
  }

  boot();
  new MutationObserver(() => {
    if (state.bootTimer) return;
    state.bootTimer = window.setTimeout(() => {
      state.bootTimer = 0;
      boot();
    }, 75);
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(scrubLeadId, 1000);
  window.setInterval(renderCustomDisposition, 150);
  window.addEventListener("resize", syncPanelGeometry);

  function escapeAttribute(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[char]));
  }

  function escapeHtml(value) {
    return escapeAttribute(value);
  }
})();
