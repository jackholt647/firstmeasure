(function () {
  const STYLE_ID = "firstmate-gmail-style";
  const TOOLBAR_ID = "firstmate-report-stack";
  const BUTTON_ID = "firstmate-modal-button";
  const LEAD_BADGE_ID = "firstmate-lead-badge";
  const MODAL_ID = "firstmate-template-modal";
  const TOAST_HOST_ID = "firstmate-toast-host";
  const LEAD_KEY = "firstmateLastLead";
  const DRAFT_KEY = "firstmateDraftMeta";
  const REPORT_SHORTCUTS = [
    { id: "residential-sample", label: "Res", title: "Residential sample", icon: "residential" },
    { id: "commercial-sample", label: "Com", title: "Commercial sample", icon: "commercial" },
    { id: "multifamily-sample", label: "Multi", title: "Multifamily sample", icon: "multifamily" }
  ];

  let lastRequestId = "";
  let lastLead = readStoredLead();
  let settingsCache = null;
  let uiRefreshTimer = 0;
  let reportStateTimer = 0;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    const montserratRegular = chrome.runtime.getURL("assets/fonts/Montserrat-Regular.ttf");
    const montserratSemiBold = chrome.runtime.getURL("assets/fonts/Montserrat-SemiBold.ttf");
    const montserratExtraBold = chrome.runtime.getURL("assets/fonts/Montserrat-ExtraBold.ttf");
    style.textContent = `
      @font-face {
        font-family: "FirstMate Montserrat";
        font-style: normal;
        font-weight: 400;
        src: url("${montserratRegular}") format("truetype");
      }

      @font-face {
        font-family: "FirstMate Montserrat";
        font-style: normal;
        font-weight: 700;
        src: url("${montserratSemiBold}") format("truetype");
      }

      @font-face {
        font-family: "FirstMate Montserrat";
        font-style: normal;
        font-weight: 800;
        src: url("${montserratExtraBold}") format("truetype");
      }

      .firstmate-gmail-toast {
        max-width: 320px;
        border-radius: 8px;
        background: #111827;
        border-top: 3px solid #db0000;
        color: #fff;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
        font: 13px/1.4 Arial, sans-serif;
        padding: 11px 12px;
      }

      #${TOAST_HOST_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        display: grid;
        gap: 8px;
        justify-items: end;
        pointer-events: none;
      }

      #${TOOLBAR_ID} {
        position: fixed;
        z-index: 2147483646;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      #${TOOLBAR_ID} button {
        align-items: center;
        background: #ffffff;
        border: 0;
        border-radius: 999px;
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.18);
        color: #111827;
        cursor: pointer;
        display: inline-flex;
        font: 700 10px/1 Arial, sans-serif;
        height: 28px;
        justify-content: center;
        padding: 0 6px;
        position: relative;
        width: 50px;
      }

      #${TOOLBAR_ID} .firstmate-report-shortcut::after {
        content: attr(data-firstmate-tooltip);
        position: absolute;
        right: calc(100% + 8px);
        top: 50%;
        transform: translateY(-50%);
        background: #111827;
        border-radius: 6px;
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.22);
        color: #fff;
        font: 700 11px/1 Arial, sans-serif;
        opacity: 0;
        padding: 7px 8px;
        pointer-events: none;
        white-space: nowrap;
      }

      #${TOOLBAR_ID} .firstmate-report-shortcut:hover::after,
      #${TOOLBAR_ID} .firstmate-report-shortcut:focus-visible::after {
        opacity: 1;
      }

      #${TOOLBAR_ID} button.is-active {
        background: #db0000;
        color: #fff;
      }

      #${TOOLBAR_ID} button:hover {
        outline: 2px solid #db0000;
      }

      #${BUTTON_ID} {
        position: fixed;
        top: 3px;
        right: 6px;
        z-index: 2147483646;
        align-items: center;
        background: #db0000;
        border: 0;
        border-radius: 50%;
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.18);
        color: #fff;
        cursor: pointer;
        display: inline-flex;
        height: 28px;
        justify-content: center;
        padding: 0;
        width: 28px;
      }

      #${BUTTON_ID} img {
        height: 24px;
        width: 24px;
      }

      #${BUTTON_ID} span {
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
        height: 1px;
        overflow: hidden;
        position: absolute;
        white-space: nowrap;
        width: 1px;
      }

      #${LEAD_BADGE_ID} {
        position: fixed;
        top: 3px;
        right: 40px;
        z-index: 2147483646;
        align-items: center;
        background: #ffffff;
        border: 1px solid rgba(17, 24, 39, 0.16);
        border-radius: 999px;
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.14);
        box-sizing: border-box;
        color: #111827;
        display: inline-flex;
        font: 700 11px/1 Arial, sans-serif;
        height: 28px;
        max-width: min(240px, calc(100vw - 88px));
        overflow: hidden;
        padding: 0 10px;
        pointer-events: none;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        align-items: center;
        background: rgba(17, 24, 39, 0.56);
        box-sizing: border-box;
        display: none;
        justify-content: center;
        padding: 28px;
      }

      #${MODAL_ID}.is-open {
        display: flex;
      }

      #${MODAL_ID} .firstmate-modal-panel {
        background: #fff;
        border-top: 5px solid #db0000;
        border-radius: 8px;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
        box-sizing: border-box;
        color: #111827;
        display: grid;
        font-family: "FirstMate Montserrat", Montserrat, 'Montserrat-Regular', Arial, sans-serif;
        gap: 14px;
        grid-template-columns: 1fr;
        max-height: min(760px, calc(100vh - 56px));
        max-width: 620px;
        overflow: auto;
        padding: 18px;
        width: min(620px, calc(100vw - 56px));
      }

      #${MODAL_ID} .firstmate-modal-header {
        align-items: center;
        display: flex;
        grid-column: 1 / -1;
        justify-content: space-between;
      }

      #${MODAL_ID} h2 {
        font-size: 19px;
        font-weight: 800;
        margin: 0;
      }

      #${MODAL_ID} h3 {
        font-size: 13px;
        font-weight: 800;
        margin: 0 0 10px;
      }

      #${MODAL_ID} .firstmate-close {
        background: #f3f4f6;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        color: #111827;
        cursor: pointer;
        font-size: 18px;
        height: 32px;
        width: 32px;
      }

      #${MODAL_ID} .firstmate-list {
        display: grid;
        gap: 8px;
      }

      #${MODAL_ID} .firstmate-sent-card {
        background: #fff7f7;
        border: 1px solid rgba(219, 0, 0, 0.18);
        border-radius: 8px;
        color: #111827;
        padding: 12px;
      }

      #${MODAL_ID} .firstmate-sent-title {
        align-items: center;
        color: #0f172a;
        display: flex;
        font-size: 15px;
        font-weight: 800;
        gap: 8px;
        margin-bottom: 8px;
      }

      #${MODAL_ID} .firstmate-sent-dot {
        background: #db0000;
        border-radius: 50%;
        box-shadow: 0 0 0 4px rgba(219, 0, 0, 0.12);
        height: 8px;
        width: 8px;
      }

      #${MODAL_ID} .firstmate-lead-card {
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        color: #111827;
        font-size: 12px;
        line-height: 1.45;
        grid-column: 1 / -1;
        padding: 12px;
      }

      #${MODAL_ID} .firstmate-lead-card h3 {
        margin-bottom: 6px;
      }

      #${MODAL_ID} .firstmate-lead-grid {
        display: grid;
        gap: 5px 10px;
        grid-template-columns: max-content minmax(0, 1fr);
      }

      #${MODAL_ID} .firstmate-lead-grid strong {
        color: #4b5563;
      }

      #${MODAL_ID} .firstmate-template-section {
        border-top: 1px solid #e5e7eb;
        padding-top: 12px;
      }

      #${MODAL_ID} button,
      #${MODAL_ID} label.firstmate-file-button {
        align-items: center;
        background: #fff;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        box-sizing: border-box;
        color: #111827;
        cursor: pointer;
        display: flex;
        font-family: inherit;
        font-size: 13px;
        font-weight: 800;
        line-height: 1.25;
        min-height: 38px;
        padding: 9px 10px;
        text-align: left;
      }

      #${MODAL_ID} button:hover,
      #${MODAL_ID} label.firstmate-file-button:hover {
        border-color: #db0000;
      }

      #${MODAL_ID} .firstmate-primary {
        background: #db0000;
        border-color: #db0000;
        color: #fff;
      }

      #${MODAL_ID} input[type="file"] {
        display: none;
      }

      @media (max-width: 720px) {
        #${MODAL_ID} .firstmate-modal-panel {
          grid-template-columns: 1fr;
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function toast(message) {
    injectStyles();
    if (findVisibleComposeRoot()) return;
    let host = document.getElementById(TOAST_HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = TOAST_HOST_ID;
      document.documentElement.appendChild(host);
    }
    const node = document.createElement("div");
    node.className = "firstmate-gmail-toast";
    node.textContent = message;
    host.appendChild(node);
    window.setTimeout(() => node.remove(), 2600);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isVisible(node) {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function firstVisible(selectors, root = document) {
    for (const selector of selectors) {
      const visible = Array.from(root.querySelectorAll(selector)).find(isVisible);
      if (visible) return visible;
    }
    return null;
  }

  function readStoredLead() {
    try {
      return JSON.parse(sessionStorage.getItem(LEAD_KEY) || "{}");
    } catch (error) {
      return {};
    }
  }

  function storeLead(lead) {
    lastLead = lead || {};
    sessionStorage.setItem(LEAD_KEY, JSON.stringify(lastLead));
  }

  function normalizeLeadPacket(packet) {
    const source = packet || {};
    const rawLead = source.lead && typeof source.lead === "object" ? source.lead : {};
    const raw = source.raw && typeof source.raw === "object" ? source.raw : rawLead;
    const detail = source.detail && typeof source.detail === "object" ? source.detail : null;
    const id = source.id || raw.id || source.lead_id || detail?.lead_id || "";
    const name = source.name || raw.lead_name || raw.name || "";
    const nameParts = String(name).split(/\s+/).filter(Boolean);
    const firstName = source.firstName || raw.first_name || nameParts[0] || "";
    const lastName = source.lastName || raw.last_name || nameParts.slice(1).join(" ") || "";
    const primaryContact = source.primaryContact && typeof source.primaryContact === "object"
      ? source.primaryContact
      : {};
    return {
      id: String(id || ""),
      crmId: String(source.crmId || raw.id || source.crm_lead_id || ""),
      fmLeadId: String(source.fmLeadId || raw.fm_lead_id || source.id || ""),
      name: String(name || ""),
      company: String(source.company || raw.company || ""),
      email: String(source.email || raw.email || ""),
      phone: String(source.phone || raw.phone || ""),
      address: String(source.address || raw.address || ""),
      website: String(source.website || raw.website || ""),
      firstName: String(firstName || ""),
      lastName: String(lastName || ""),
      primaryContact: {
        id: String(primaryContact.id || source.contactId || ""),
        fullName: String(primaryContact.fullName || [firstName, lastName].filter(Boolean).join(" ") || ""),
        firstName: String(primaryContact.firstName || firstName || ""),
        lastName: String(primaryContact.lastName || lastName || ""),
        email: String(primaryContact.email || source.email || "").trim().toLowerCase()
      },
      contactId: String(primaryContact.id || source.contactId || ""),
      raw,
      detail,
      contacts: Array.isArray(source.contacts) ? source.contacts : [],
      notes: Array.isArray(source.notes) ? source.notes : [],
      followups: Array.isArray(source.followups) ? source.followups : [],
      dialEvents: Array.isArray(source.dialEvents) ? source.dialEvents : [],
      pageTitle: source.pageTitle || "",
      pageUrl: source.pageUrl || ""
    };
  }

  function leadCompanyLabel(lead = lastLead) {
    return String(lead?.company || lead?.name || lead?.id || "").trim();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[char]));
  }

  function leadInfoHtml(lead = lastLead) {
    const rows = [
      ["Company", lead.company],
      ["Lead", lead.name],
      ["Lead ID", lead.id],
      ["CRM ID", lead.crmId],
      ["Email", lead.email],
      ["Phone", lead.phone],
      ["Address", lead.address],
      ["Website", lead.website]
    ].filter(([, value]) => String(value || "").trim());
    if (!rows.length) {
      return "";
    }
    return `
      <div class="firstmate-lead-card">
        <h3>Active lead</h3>
        <div class="firstmate-lead-grid">
          ${rows.map(([label, value]) => `<strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span>`).join("")}
        </div>
      </div>
    `;
  }

  function formatEmailList(values) {
    const list = Array.isArray(values) ? values : [];
    return list.length ? list.join(", ") : "None";
  }

  function sentEventHtml(event) {
    if (!event) return "";
    const reports = Array.isArray(event.reports)
      ? event.reports.map((report) => report.filename || report.name || report.id || "").filter(Boolean)
      : [];
    return `
      <div class="firstmate-sent-card">
        <div class="firstmate-sent-title"><span class="firstmate-sent-dot"></span>Email successfully sent</div>
        <div class="firstmate-lead-grid">
          <strong>To</strong><span>${escapeHtml(formatEmailList(event.to))}</span>
          <strong>CC</strong><span>${escapeHtml(formatEmailList(event.cc))}</span>
          <strong>BCC</strong><span>${escapeHtml(formatEmailList(event.bcc))}</span>
          <strong>Reports</strong><span>${escapeHtml(reports.length ? reports.join(", ") : "None")}</span>
        </div>
      </div>
    `;
  }

  function readDraftMeta() {
    try {
      return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}");
    } catch (error) {
      return {};
    }
  }

  function storeDraftMeta(meta) {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(meta || {}));
  }

  async function getSettings() {
    if (settingsCache) return settingsCache;
    const response = await chrome.runtime.sendMessage({ type: "FIRSTMATE_GET_SETTINGS" });
    settingsCache = response?.settings || {};
    return settingsCache;
  }

  function fillEditable(editable, value) {
    editable.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, value || "");
    editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value || "" }));
  }

  function setInputValue(input, value) {
    input.focus();
    input.value = value || "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitForVisible(selectors, timeoutMs = 7000, root = document) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const node = firstVisible(Array.isArray(selectors) ? selectors : [selectors], root);
      if (node) return node;
      await sleep(150);
    }
    return null;
  }

  function buildComposeUrl(payload) {
    const lead = payload.lead || {};
    const params = new URLSearchParams({ view: "cm", fs: "1", tf: "1" });
    if (payload.to) params.set("to", payload.to);
    if (payload.subject) params.set("su", applyTemplate(payload.subject, lead));
    if (payload.body) params.set("body", applyTemplate(payload.body, lead));

    const match = location.pathname.match(/^\/mail\/u\/[^/]+/);
    const basePath = match ? `${match[0]}/` : "/mail/";
    return `${location.origin}${basePath}?${params.toString()}`;
  }

  function openComposeUrl(payload) {
    const nextUrl = buildComposeUrl(payload);
    window.setTimeout(() => {
      if (location.href === nextUrl) return;
      location.assign(nextUrl);
    }, 80);
    return { ok: true, navigated: true, url: nextUrl };
  }

  async function findComposeRoot(timeoutMs = 7000) {
    return waitForVisible([
      "div[role='dialog'][aria-label*='New Message']",
      "div[role='dialog']",
      "div[aria-label*='Message Body'][contenteditable='true']"
    ], timeoutMs);
  }

  async function findComposeScope() {
    const root = await findComposeRoot(700);
    return root && root.matches("div[role='dialog']") ? root : document;
  }

  function findVisibleComposeRoot() {
    const body = firstVisible([
      "div[aria-label='Message Body'][contenteditable='true']",
      "div[aria-label*='Message Body'][contenteditable='true']",
      "div[role='textbox'][contenteditable='true']"
    ]);
    return body?.closest("[role='dialog']") || body?.closest(".GP") || null;
  }

  async function findComposeBody(timeoutMs = 2000) {
    return waitForVisible([
      "div[aria-label='Message Body'][contenteditable='true']",
      "div[aria-label*='Message Body'][contenteditable='true']",
      "div[role='textbox'][contenteditable='true']"
    ], timeoutMs);
  }

  function findSubjectForBody(body) {
    const shell = body?.closest(".GP") || body?.closest("[role='dialog']") || document;
    return firstVisible(["input[name='subjectbox']"], shell) || firstVisible(["input[name='subjectbox']"]);
  }

  function findComposeFromNode(node) {
    const start = node?.closest?.("[role='button'], button, div") || node;
    return start?.closest?.(".GP, div[role='dialog'], .nH") || findVisibleComposeRoot() || document;
  }

  function extractEmails(value) {
    return (String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
      .map((email) => email.trim().toLowerCase());
  }

  function recipientBucketForNode(node) {
    const parts = [];
    let current = node;
    for (let depth = 0; current && depth < 5; depth += 1) {
      parts.push(current.getAttribute?.("aria-label") || "");
      parts.push(current.getAttribute?.("name") || "");
      parts.push(current.getAttribute?.("data-tooltip") || "");
      parts.push(current.getAttribute?.("title") || "");
      parts.push(current.textContent || "");
      current = current.parentElement;
    }
    const text = normalizeText(parts.join(" "));
    if (/\bbcc\b/.test(text) || text.includes("blind carbon copy")) return "bcc";
    if (/\bcc\b/.test(text) || text.includes("carbon copy")) return "cc";
    return "to";
  }

  function uniqueRecipients(buckets) {
    const seen = new Set();
    ["to", "cc", "bcc"].forEach((bucket) => {
      buckets[bucket] = buckets[bucket].filter((email) => {
        const key = `${bucket}:${email}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
    buckets.all = Array.from(new Set([...buckets.to, ...buckets.cc, ...buckets.bcc]));
    return buckets;
  }

  function findRecipientBuckets(scope) {
    const compose = scope || findVisibleComposeRoot() || document;
    const buckets = { to: [], cc: [], bcc: [], all: [] };
    const add = (bucket, value) => {
      extractEmails(value).forEach((email) => {
        if (!buckets[bucket].includes(email)) buckets[bucket].push(email);
      });
    };

    Array.from(compose.querySelectorAll("input, textarea")).forEach((node) => {
      const bucket = recipientBucketForNode(node);
      add(bucket, node.value);
      add(bucket, node.getAttribute("value"));
      add(bucket, node.getAttribute("aria-label"));
      add(bucket, node.getAttribute("name"));
    });

    Array.from(compose.querySelectorAll("[email], [data-email], [data-hovercard-id], [aria-label], [title], [data-tooltip]"))
      .forEach((node) => {
        const bucket = recipientBucketForNode(node);
        [
          "email",
          "data-email",
          "data-hovercard-id",
          "aria-label",
          "title",
          "data-tooltip"
        ].forEach((attribute) => add(bucket, node.getAttribute(attribute)));
      });

    Array.from(compose.querySelectorAll("tr, table, div")).forEach((node) => {
      const text = node.innerText || node.textContent || "";
      if (!/@/.test(text)) return;
      add(recipientBucketForNode(node), text);
    });

    return uniqueRecipients(buckets);
  }

  function findCurrentSubject() {
    const compose = findVisibleComposeRoot() || document;
    return firstVisible(["input[name='subjectbox']"], compose)?.value || firstVisible(["input[name='subjectbox']"])?.value || "";
  }

  function firstGreetingNameCandidate(compose) {
    const body = firstVisible([
      "div[aria-label='Message Body'][contenteditable='true']",
      "div[aria-label*='Message Body'][contenteditable='true']",
      "div[role='textbox'][contenteditable='true']"
    ], compose || findVisibleComposeRoot() || document);
    const text = String(body?.innerText || body?.textContent || "")
      .replace(/\u00a0/g, " ")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "";
    const match = text.match(/^(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\s+([^,\n.!?:;]+)/i);
    if (!match?.[1]) return "";
    const candidate = match[1].trim().replace(/^there\b/i, "").trim();
    const first = candidate.split(/\s+/).filter(Boolean)[0] || "";
    if (!/^[a-z][a-z'’-]{1,31}$/i.test(first)) return "";
    return first;
  }

  async function applyTemplateToOpenCompose(template) {
    const bodyField = await findComposeBody(2500);
    const lead = lastLead || {};
    const subjectField = findSubjectForBody(bodyField);

    if (subjectField) setInputValue(subjectField, applyTemplate(template.subject || "", lead));
    if (bodyField) fillEditable(bodyField, applyTemplate(template.body || "", lead));
    toast(subjectField || bodyField ? `Loaded ${template.name || "template"}.` : "Open a Gmail compose window first.");
  }

  async function useTemplateFromModal(template) {
    const bodyField = await findComposeBody(500);
    if (bodyField) {
      await applyTemplateToOpenCompose(template);
      closeModal();
      return;
    }
    const lead = lastLead || {};
    storeDraftMeta({
      requestId: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      templateId: template.id || "",
      sourceUrl: lead.pageUrl || "",
      lead,
      subject: template.subject || ""
    });
    openComposeUrl({
      subject: template.subject || "",
      body: template.body || "",
      lead
    });
    closeModal();
  }

  function dataUrlToFile(file) {
    const parts = String(file.dataUrl || "").split(",");
    const meta = parts[0] || "";
    const body = parts[1] || "";
    const mime = file.type || (meta.match(/data:([^;]+)/) || [])[1] || "application/pdf";
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], file.name || "sample-report.pdf", { type: mime });
  }

  async function waitForAttachment(filename, timeoutMs = 3500) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (findAttachmentChip(filename)) return true;
      await sleep(250);
    }
    return false;
  }

  async function attachFiles(files, expectedFilename = "") {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));

    const gmailFileInput = Array.from(document.querySelectorAll("input[type='file']")).find((input) => {
      const accept = String(input.getAttribute("accept") || "").toLowerCase();
      return !accept || accept.includes("pdf") || accept.includes("*") || accept.includes("application/");
    });

    if (gmailFileInput) {
      gmailFileInput.files = transfer.files;
      gmailFileInput.dispatchEvent(new Event("input", { bubbles: true }));
      gmailFileInput.dispatchEvent(new Event("change", { bubbles: true }));
      if (!expectedFilename || await waitForAttachment(expectedFilename, 2500)) {
        toast(`Queued ${files.length} attachment${files.length === 1 ? "" : "s"}.`);
        return true;
      }
    }

    const dropTarget = await findComposeBody(2500);

    if (dropTarget) {
      ["dragenter", "dragover", "drop"].forEach((type) => {
        dropTarget.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer
        }));
      });
      if (!expectedFilename || await waitForAttachment(expectedFilename, 3500)) {
        toast(`Dropped ${files.length} attachment${files.length === 1 ? "" : "s"} into Gmail.`);
        return true;
      }
    }

    toast("Gmail did not accept the sample report attachment.");
    return false;
  }

  async function attachReport(report) {
    toast(`Loading ${report.name || "sample report"}...`);
    const response = await chrome.runtime.sendMessage({ type: "FIRSTMATE_FETCH_REPORT", report });
    if (!response?.ok) {
      toast(response?.error || "Could not load sample report.");
      return false;
    }
    const filename = response.file?.name || filenameForReport(report);
    return attachFiles([dataUrlToFile(response.file)], filename);
  }

  function reportById(reports, id) {
    return reports.find((report) => report?.id === id)
      || reports.find((report) => String(report?.url || "").includes(`${id.replace("-sample", "")}-sample.pdf`));
  }

  function filenameForReport(report) {
    if (report?.filename) return report.filename;
    try {
      return decodeURIComponent(new URL(report.url).pathname.split("/").pop() || "");
    } catch (error) {
      return "";
    }
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function findAttachmentChip(filename) {
    const target = normalizeText(filename);
    if (!target) return null;
    const scope = findVisibleComposeRoot() || document;
    const candidates = Array.from(scope.querySelectorAll("div, span, table, tr, td"))
      .filter(isVisible)
      .filter((node) => normalizeText(node.textContent).includes(target));
    return candidates
      .map((node) => node.closest("tr, table, div") || node)
      .find((node) => isVisible(node)) || null;
  }

  function isReportAttached(report) {
    return Boolean(findAttachmentChip(filenameForReport(report)));
  }

  function clickRemoveAttachment(report) {
    const chip = findAttachmentChip(filenameForReport(report));
    if (!chip) return false;

    const controls = Array.from(chip.querySelectorAll("[role='button'], button, div, span"))
      .filter(isVisible)
      .filter((node) => {
        const label = normalizeText([
          node.getAttribute("aria-label"),
          node.getAttribute("data-tooltip"),
          node.getAttribute("title"),
          node.textContent
        ].filter(Boolean).join(" "));
        return label.includes("remove")
          || label.includes("delete")
          || label.includes("cancel")
          || label === "x"
          || label === "×";
      });

    const control = controls[0] || Array.from(chip.querySelectorAll("[role='button'], button")).filter(isVisible).pop();
    if (!control) return false;
    control.click();
    return true;
  }

  function updateReportToggleState() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar || !settingsCache?.sampleReports) return;
    REPORT_SHORTCUTS.forEach((shortcut) => {
      const report = reportById(settingsCache.sampleReports, shortcut.id);
      const button = toolbar.querySelector(`[data-report-id="${shortcut.id}"]`);
      if (!button || !report) return;
      button.classList.toggle("is-active", isReportAttached(report));
    });
  }

  function scheduleReportStateUpdate(delayMs = 350) {
    if (reportStateTimer) return;
    reportStateTimer = window.setTimeout(() => {
      reportStateTimer = 0;
      updateReportToggleState();
    }, delayMs);
  }

  function attachedSampleReports() {
    const reports = settingsCache?.sampleReports || [];
    return REPORT_SHORTCUTS
      .map((shortcut) => reportById(reports, shortcut.id))
      .filter(Boolean)
      .filter((report) => isReportAttached(report))
      .map((report) => ({
        id: report.id || "",
        name: report.name || "",
        filename: filenameForReport(report),
        url: report.url || ""
      }));
  }

  async function toggleReport(report) {
    if (isReportAttached(report)) {
      if (clickRemoveAttachment(report)) {
        window.setTimeout(updateReportToggleState, 250);
      } else {
        toast("Could not find the attachment remove button.");
      }
      return;
    }

    const attached = await attachReport(report);
    if (attached) {
      window.setTimeout(updateReportToggleState, 800);
      window.setTimeout(updateReportToggleState, 1800);
    }
  }

  function positionReportStack() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;
    const compose = findVisibleComposeRoot();
    if (!compose) return;
    const rect = compose.getBoundingClientRect();
    toolbar.style.right = `${Math.max(0, Math.round(window.innerWidth - rect.right - 7))}px`;
    toolbar.style.bottom = `${Math.max(6, Math.round(window.innerHeight - rect.bottom + 60))}px`;
  }

  async function renderFloatingButton() {
    injectStyles();
    if (!document.body) return;
    const hasCompose = Boolean(firstVisible([
      "div[aria-label='Message Body'][contenteditable='true']",
      "div[aria-label*='Message Body'][contenteditable='true']",
      "div[role='textbox'][contenteditable='true']"
    ]));
    const existingToolbar = document.getElementById(TOOLBAR_ID);
    if (!hasCompose) {
      existingToolbar?.remove();
      return;
    }
    if (existingToolbar) {
      positionReportStack();
      return;
    }

    const settings = await getSettings();
    const reports = Array.isArray(settings.sampleReports) ? settings.sampleReports : [];

    const toolbar = document.createElement("div");
    toolbar.id = TOOLBAR_ID;

    REPORT_SHORTCUTS.forEach((shortcut) => {
      const reportButton = document.createElement("button");
      reportButton.className = "firstmate-report-shortcut";
      reportButton.type = "button";
      reportButton.dataset.firstmateTooltip = shortcut.title;
      reportButton.dataset.reportId = shortcut.id;
      reportButton.textContent = shortcut.label;
      reportButton.addEventListener("click", () => {
        const report = reportById(reports, shortcut.id);
        if (report) {
          toggleReport(report);
        } else {
          toast(`Could not find ${shortcut.label} sample report.`);
        }
      });
      toolbar.appendChild(reportButton);
    });
    document.body.appendChild(toolbar);
    positionReportStack();
    scheduleReportStateUpdate(250);
  }

  function renderLeadBadge() {
    injectStyles();
    if (!document.body) return;
    const hasCompose = Boolean(firstVisible([
      "div[aria-label='Message Body'][contenteditable='true']",
      "div[aria-label*='Message Body'][contenteditable='true']",
      "div[role='textbox'][contenteditable='true']"
    ]));
    const existingBadge = document.getElementById(LEAD_BADGE_ID);
    const label = leadCompanyLabel();
    if (!hasCompose || !label) {
      existingBadge?.remove();
      return;
    }
    if (existingBadge) {
      existingBadge.textContent = label;
      return;
    }
    const badge = document.createElement("div");
    badge.id = LEAD_BADGE_ID;
    badge.textContent = label;
    document.body.appendChild(badge);
  }

  function renderModalButton() {
    injectStyles();
    if (!document.body) return;
    const hasCompose = Boolean(firstVisible([
      "div[aria-label='Message Body'][contenteditable='true']",
      "div[aria-label*='Message Body'][contenteditable='true']",
      "div[role='textbox'][contenteditable='true']"
    ]));
    const existingButton = document.getElementById(BUTTON_ID);
    if (!hasCompose) {
      existingButton?.remove();
      return;
    }
    if (existingButton) return;

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.setAttribute("aria-label", "FirstMate templates and reports");
    button.innerHTML = `<img alt="" src="${chrome.runtime.getURL("assets/icon_red.png")}"><span>FirstMate</span>`;
    button.addEventListener("click", openModal);
    document.body.appendChild(button);
  }

  function refreshFirstMateUi() {
    renderModalButton();
    renderLeadBadge();
    renderFloatingButton();
  }

  function scheduleFirstMateUiRefresh(delayMs = 500) {
    if (uiRefreshTimer) return;
    uiRefreshTimer = window.setTimeout(() => {
      uiRefreshTimer = 0;
      refreshFirstMateUi();
    }, delayMs);
  }

  async function openModal(context = {}) {
    injectStyles();
    const existing = document.getElementById(MODAL_ID);
    if (existing) {
      existing.remove();
    }

    const settings = await getSettings();
    const templates = Array.isArray(settings.templates) ? settings.templates : [];
    const sentEvent = context.sentEvent || null;
    const title = sentEvent ? "Email sent" : "Lead details";
    const templateHeading = sentEvent ? "Send another email" : "Templates";

    const modal = document.createElement("section");
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="firstmate-modal-panel" role="dialog" aria-modal="true" aria-label="FirstMate lead details">
        <div class="firstmate-modal-header">
          <h2>${escapeHtml(title)}</h2>
          <button class="firstmate-close" type="button" aria-label="Close">x</button>
        </div>
        ${sentEventHtml(sentEvent)}
        ${leadInfoHtml(lastLead)}
        <div class="firstmate-template-section">
          <h3>${escapeHtml(templateHeading)}</h3>
          <div class="firstmate-list" data-firstmate-templates></div>
        </div>
      </div>
    `;

    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal();
    });
    modal.querySelector(".firstmate-close").addEventListener("click", closeModal);

    const templateList = modal.querySelector("[data-firstmate-templates]");
    templates.forEach((template) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = template.name || "Template";
      button.addEventListener("click", () => useTemplateFromModal(template));
      templateList.appendChild(button);
    });

    document.body.appendChild(modal);
    modal.classList.add("is-open");
  }

  function closeModal() {
    document.getElementById(MODAL_ID)?.classList.remove("is-open");
  }

  async function composeEmail(command) {
    if (!command || command.requestId === lastRequestId) return { ok: true, deduped: true };
    lastRequestId = command.requestId;

    const payload = command.payload || {};
    const lead = normalizeLeadPacket(payload.lead || {});
    storeLead(lead);
    storeDraftMeta({
      requestId: command.requestId || "",
      requestedAt: command.requestedAt || "",
      templateId: payload.templateId || "",
      sourceUrl: payload.sourceUrl || "",
      lead,
      subject: payload.subject || ""
    });
    renderLeadBadge();
    toast("FirstMate opening Gmail compose.");
    const urlResult = openComposeUrl({ ...payload, lead });

    chrome.runtime.sendMessage({
      type: "FIRSTMATE_GMAIL_EVENT",
      event: {
        action: "compose_url_opened",
        requestId: command.requestId,
        at: new Date().toISOString()
      }
    });
    return { ok: true, composeUrl: urlResult.url };
  }

  async function setActiveLead(command) {
    if (!command || command.requestId === lastRequestId) return { ok: true, deduped: true };
    lastRequestId = command.requestId;
    const payload = command.payload || {};
    const lead = normalizeLeadPacket(payload.lead || {});
    storeLead(lead);
    storeDraftMeta({
      requestId: command.requestId || "",
      requestedAt: command.requestedAt || "",
      templateId: "",
      sourceUrl: lead.pageUrl || "",
      lead,
      subject: ""
    });
    renderLeadBadge();
    if (!payload.openBlankCompose) {
      return { ok: true, lead };
    }
    const urlResult = openComposeUrl({
      to: "",
      subject: "",
      body: "",
      lead
    });
    return { ok: true, lead, composeUrl: urlResult.url };
  }

  function applyTemplate(template, lead) {
    return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
      return lead && lead[key] != null ? String(lead[key]) : "";
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "FIRSTMATE_COMPOSE_EMAIL" && message?.type !== "FIRSTMATE_SET_ACTIVE_LEAD") return;
    const action = message.type === "FIRSTMATE_SET_ACTIVE_LEAD" ? setActiveLead : composeEmail;
    action(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  function isSendButton(node) {
    const button = node?.closest?.("[role='button'], button, div");
    if (!button || !isVisible(button)) return false;
    const label = normalizeText([
      button.getAttribute("aria-label"),
      button.getAttribute("data-tooltip"),
      button.getAttribute("title"),
      button.textContent
    ].filter(Boolean).join(" "));
    return label === "send" || label.startsWith("send ") || label.includes("send ctrl") || label.includes("send ⌘");
  }

  function recordSendClick(target) {
    const meta = readDraftMeta();
    if (!meta.requestId && !meta.templateId && !meta.sourceUrl) return;
    const compose = findComposeFromNode(target);
    const recipients = findRecipientBuckets(compose);
    const greetingFirstName = firstGreetingNameCandidate(compose);
    const event = {
      sentAt: new Date().toISOString(),
      requestId: meta.requestId || "",
      requestedAt: meta.requestedAt || "",
      templateId: meta.templateId || "",
      sourceUrl: meta.sourceUrl || "",
      lead: meta.lead || {},
      leadId: meta.lead?.id || "",
      contactId: meta.lead?.primaryContact?.id || meta.lead?.contactId || "",
      contact: meta.lead?.primaryContact || null,
      greetingFirstName,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      recipients,
      subject: findCurrentSubject() || meta.subject || "",
      reports: attachedSampleReports(),
      gmailUrl: location.href
    };
    chrome.runtime.sendMessage({ type: "FIRSTMATE_EMAIL_SENT", event })
      .then(() => openModal({ sentEvent: event }))
      .catch(() => openModal({ sentEvent: event }));
    sessionStorage.removeItem(DRAFT_KEY);
  }

  document.addEventListener("click", (event) => {
    if (isSendButton(event.target)) {
      recordSendClick(event.target);
    }
  }, true);

  chrome.runtime.sendMessage({
    type: "FIRSTMATE_GMAIL_EVENT",
    event: {
      action: "gmail_listener_ready",
      at: new Date().toISOString()
    }
  });

  refreshFirstMateUi();
  const observer = new MutationObserver(() => {
    scheduleFirstMateUiRefresh();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("resize", () => {
    positionReportStack();
    scheduleReportStateUpdate(250);
  });
  window.setInterval(() => {
    if (findVisibleComposeRoot()) {
      scheduleReportStateUpdate(0);
    }
  }, 3000);
})();
