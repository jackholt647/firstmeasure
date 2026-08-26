(function () {
  if (!window.Portal) return;

  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const esc = (value) => window.Portal.escapeHtml(value);

  const state = {
    initialized: false,
    loading: false,
    previewing: false,
    sending: false,
    error: "",
    bootstrap: {
      templates: [],
      users: [],
      lists: [],
      stages: [],
    },
    filters: {
      stage: "",
      list_id: "",
      assigned_to_email: "",
      q: "",
    },
    composeMode: "template",
    templateId: "",
    customSubject: "",
    customBody: "",
    preview: null,
    results: null,
  };

  function api(payload) {
    return window.Portal.apiPost(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), payload);
  }

  function ensureStyles() {
    if (document.getElementById("bulkEmailStyles")) return;
    const style = document.createElement("style");
    style.id = "bulkEmailStyles";
    style.textContent = `
      .bulk-email-shell{display:grid;gap:18px;min-height:0}
      .bulk-email-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
      .bulk-email-head-copy{display:grid;gap:6px}
      .bulk-email-head-copy h2{margin:0;font-size:28px;font-weight:900;color:#223040;letter-spacing:-.03em}
      .bulk-email-head-copy p{margin:0;font-size:13px;color:#667487;line-height:1.6;max-width:860px}
      .bulk-email-actions{display:flex;gap:8px;flex-wrap:wrap}
      .bulk-email-btn{border:none;border-radius:12px;padding:10px 14px;font-size:12px;font-weight:800;cursor:pointer}
      .bulk-email-btn.primary{background:#d93025;color:#fff}
      .bulk-email-btn.primary:disabled,.bulk-email-btn.secondary:disabled{opacity:.6;cursor:not-allowed}
      .bulk-email-btn.secondary{background:#fff;border:1px solid #d7dee9;color:#334155}
      .bulk-email-layout{display:grid;grid-template-columns:minmax(320px,360px) minmax(0,1fr);gap:16px;align-items:start;min-height:0}
      .bulk-email-card{background:#fff;border:1px solid #e6eaf0;border-radius:18px;overflow:hidden;box-shadow:0 12px 28px rgba(16,24,40,.05);min-width:0}
      .bulk-email-card-head{padding:16px 18px;border-bottom:1px solid #eef2f6;background:linear-gradient(180deg,#fcfdff,#f7f9fc)}
      .bulk-email-card-head h3{margin:0;font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#5f6b7d}
      .bulk-email-card-head p{margin:6px 0 0;font-size:12px;color:#6f7b8b;line-height:1.5}
      .bulk-email-card-body{padding:16px 18px;display:grid;gap:12px}
      .bulk-email-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      .bulk-email-field{display:grid;gap:6px}
      .bulk-email-field.full{grid-column:1 / -1}
      .bulk-email-field label{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#738095}
      .bulk-email-input,.bulk-email-select,.bulk-email-textarea{width:100%;box-sizing:border-box;border:1px solid #d7dee9;border-radius:12px;padding:10px 12px;font:inherit;color:#223040;background:#fff}
      .bulk-email-textarea{min-height:128px;resize:vertical;line-height:1.55}
      .bulk-email-mode-row{display:flex;gap:8px;flex-wrap:wrap}
      .bulk-email-mode-btn{border:1px solid #d7dee9;background:#fff;border-radius:999px;padding:8px 12px;font-size:11px;font-weight:900;color:#445366;cursor:pointer}
      .bulk-email-mode-btn.active{background:#223040;border-color:#223040;color:#fff}
      .bulk-email-template-chip-row{display:flex;gap:6px;flex-wrap:wrap}
      .bulk-email-template-chip{border:1px solid #d7dee9;background:#fff;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:800;color:#445366;cursor:pointer}
      .bulk-email-template-chip.active{background:#d93025;border-color:#d93025;color:#fff}
      .bulk-email-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
      .bulk-email-metric{background:#fff;border:1px solid #e6eaf0;border-radius:14px;padding:14px 16px;box-shadow:0 10px 20px rgba(16,24,40,.04)}
      .bulk-email-metric .k{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#7a8595}
      .bulk-email-metric .v{margin-top:6px;font-size:24px;font-weight:900;color:#223040}
      .bulk-email-metric .m{margin-top:4px;font-size:11px;color:#667487}
      .bulk-email-status{font-size:12px;font-weight:800;color:#667487}
      .bulk-email-status.error{color:#b42318}
      .bulk-email-preview-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
      .bulk-email-results-summary{display:flex;gap:8px;flex-wrap:wrap}
      .bulk-email-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:6px 10px;font-size:11px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}
      .bulk-email-pill.sent{background:#e7f6ec;color:#157347}
      .bulk-email-pill.skipped{background:#fff7ea;color:#9a5b00}
      .bulk-email-pill.error{background:#fce8e6;color:#b42318}
      .bulk-email-table-wrap{overflow:auto}
      .bulk-email-table{width:100%;border-collapse:collapse}
      .bulk-email-table th,.bulk-email-table td{padding:10px 8px;border-bottom:1px solid #eef2f6;vertical-align:top;text-align:left;font-size:12px}
      .bulk-email-table th{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#738095;background:#fbfcfe;position:sticky;top:0}
      .bulk-email-company{font-weight:900;color:#223040}
      .bulk-email-meta{margin-top:4px;color:#667487;line-height:1.45}
      .bulk-email-tag{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
      .bulk-email-tag.ready{background:#e7f6ec;color:#157347}
      .bulk-email-tag.skip{background:#fff7ea;color:#9a5b00}
      .bulk-email-tag.error{background:#fce8e6;color:#b42318}
      .bulk-email-empty{padding:28px 16px;text-align:center;color:#7b8797;font-weight:700}
      .bulk-email-note{font-size:12px;color:#667487;line-height:1.6}
      .bulk-email-error{background:#fce8e6;border:1px solid #f4c7c3;color:#b42318;border-radius:12px;padding:12px 14px;font-size:13px;font-weight:700}
      @media (max-width: 1080px){
        .bulk-email-layout{grid-template-columns:1fr}
      }
      @media (max-width: 760px){
        .bulk-email-grid{grid-template-columns:1fr}
      }
    `;
    document.head.appendChild(style);
  }

  function currentTemplate() {
    return (Array.isArray(state.bootstrap.templates) ? state.bootstrap.templates : []).find(
      (item) => String(item?.id || "") === String(state.templateId || ""),
    ) || null;
  }

  function counts() {
    return state.preview?.counts || {
      matched: 0,
      with_email: 0,
      existing_thread: 0,
      ready_to_send: 0,
      skipped_no_email: 0,
      skipped_no_gmail: 0,
      skipped_dnc: 0,
    };
  }

  function composePayload() {
    return {
      stage: state.filters.stage || "",
      list_id: state.filters.list_id || "",
      assigned_to_email: state.filters.assigned_to_email || "",
      q: state.filters.q || "",
      template_id: state.composeMode === "template" ? state.templateId || "" : "",
      custom_subject: state.composeMode === "custom" ? state.customSubject || "" : "",
      custom_body: state.composeMode === "custom" ? state.customBody || "" : "",
    };
  }

  async function loadBootstrap(force) {
    if (state.loading && !force) return;
    state.loading = true;
    state.error = "";
    render();
    try {
      const data = await api({ action: "lead_bulk_email_bootstrap" });
      if (!data || data.success === false) {
        throw new Error(data?.error || "Could not load bulk email.");
      }
      state.bootstrap = {
        templates: Array.isArray(data.templates) ? data.templates : [],
        users: Array.isArray(data.users) ? data.users : [],
        lists: Array.isArray(data.lists) ? data.lists : [],
        stages: Array.isArray(data.stages) ? data.stages : [],
      };
      if (!state.templateId && state.bootstrap.templates[0]?.id) {
        state.templateId = String(state.bootstrap.templates[0].id);
      }
    } catch (err) {
      state.error = err?.message || "Could not load bulk email.";
    } finally {
      state.loading = false;
      render();
    }
  }

  async function runPreview() {
    if (state.previewing || state.loading) return;
    state.previewing = true;
    state.error = "";
    state.results = null;
    render();
    try {
      const data = await api({
        action: "lead_bulk_email_preview",
        ...composePayload(),
      });
      if (!data || data.success === false) {
        throw new Error(data?.error || "Could not build the bulk email preview.");
      }
      state.preview = {
        rows: Array.isArray(data.rows) ? data.rows : [],
        counts: data.counts || null,
      };
      if (Array.isArray(data.templates) && data.templates.length) {
        state.bootstrap.templates = data.templates;
      }
    } catch (err) {
      state.error = err?.message || "Could not build the bulk email preview.";
    } finally {
      state.previewing = false;
      render();
    }
  }

  async function runSend() {
    if (state.sending || state.loading || state.previewing) return;
    const previewCounts = counts();
    const ready = Number(previewCounts.ready_to_send || 0);
    if (!ready) {
      state.error = "Nothing is ready to send yet. Run a preview first.";
      render();
      return;
    }
    const confirmed = window.confirm(`Send individualized emails to ${ready} recipient${ready === 1 ? "" : "s"}?`);
    if (!confirmed) return;
    state.sending = true;
    state.error = "";
    render();
    try {
      const data = await api({
        action: "lead_bulk_email_send",
        ...composePayload(),
      });
      if (!data || data.success === false) {
        throw new Error(data?.error || "Could not send the bulk email.");
      }
      state.preview = {
        rows: Array.isArray(data.results) ? data.results : [],
        counts: data.preview_counts || state.preview?.counts || null,
      };
      state.results = {
        rows: Array.isArray(data.results) ? data.results : [],
        summary: data.summary || {},
      };
    } catch (err) {
      state.error = err?.message || "Could not send the bulk email.";
    } finally {
      state.sending = false;
      render();
    }
  }

  function bind(container) {
    container.querySelectorAll("[data-bulk-email-filter]").forEach((input) => {
      if (input.dataset.wired === "true") return;
      input.dataset.wired = "true";
      const apply = () => {
        const key = input.getAttribute("data-bulk-email-filter") || "";
        state.filters[key] = input.value || "";
      };
      input.addEventListener("input", apply);
      input.addEventListener("change", apply);
    });
    container.querySelectorAll("[data-bulk-email-mode]").forEach((btn) => {
      if (btn.dataset.wired === "true") return;
      btn.dataset.wired = "true";
      btn.addEventListener("click", () => {
        state.composeMode = btn.getAttribute("data-bulk-email-mode") || "template";
        render();
      });
    });
    container.querySelectorAll("[data-bulk-email-template]").forEach((btn) => {
      if (btn.dataset.wired === "true") return;
      btn.dataset.wired = "true";
      btn.addEventListener("click", () => {
        state.templateId = btn.getAttribute("data-bulk-email-template") || "";
        render();
      });
    });
    const refreshBtn = container.querySelector("[data-bulk-email-refresh]");
    if (refreshBtn && refreshBtn.dataset.wired !== "true") {
      refreshBtn.dataset.wired = "true";
      refreshBtn.addEventListener("click", () => loadBootstrap(true));
    }
    const previewBtn = container.querySelector("[data-bulk-email-preview]");
    if (previewBtn && previewBtn.dataset.wired !== "true") {
      previewBtn.dataset.wired = "true";
      previewBtn.addEventListener("click", () => runPreview());
    }
    const sendBtn = container.querySelector("[data-bulk-email-send]");
    if (sendBtn && sendBtn.dataset.wired !== "true") {
      sendBtn.dataset.wired = "true";
      sendBtn.addEventListener("click", () => runSend());
    }
    const customSubject = container.querySelector("[data-bulk-email-custom-subject]");
    if (customSubject && customSubject.dataset.wired !== "true") {
      customSubject.dataset.wired = "true";
      customSubject.addEventListener("input", () => {
        state.customSubject = customSubject.value || "";
      });
    }
    const customBody = container.querySelector("[data-bulk-email-custom-body]");
    if (customBody && customBody.dataset.wired !== "true") {
      customBody.dataset.wired = "true";
      customBody.addEventListener("input", () => {
        state.customBody = customBody.value || "";
      });
    }
  }

  function renderMetricsHtml() {
    const c = counts();
    return `
      <div class="bulk-email-metrics">
        <div class="bulk-email-metric"><div class="k">Matched Leads</div><div class="v">${esc(c.matched || 0)}</div><div class="m">Current filter result</div></div>
        <div class="bulk-email-metric"><div class="k">With Email</div><div class="v">${esc(c.with_email || 0)}</div><div class="m">Address available</div></div>
        <div class="bulk-email-metric"><div class="k">Existing Thread</div><div class="v">${esc(c.existing_thread || 0)}</div><div class="m">Will reply in thread</div></div>
        <div class="bulk-email-metric"><div class="k">Ready To Send</div><div class="v">${esc(c.ready_to_send || 0)}</div><div class="m">Eligible right now</div></div>
      </div>
    `;
  }

  function renderRows(rows, showResultColumns) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      return `<div class="bulk-email-empty">Run a preview to see exactly which leads will be emailed.</div>`;
    }
    return `
      <div class="bulk-email-table-wrap">
        <table class="bulk-email-table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Assigned SDR</th>
              <th>Recipient</th>
              <th>Thread</th>
              <th>Subject</th>
              <th>Status</th>
              ${showResultColumns ? "<th>Result</th>" : ""}
            </tr>
          </thead>
          <tbody>
            ${list.map((row) => {
              const ready = !!row.ready && !row.skip_reason;
              const statusClass = ready ? "ready" : (String(row.status || "").toLowerCase() === "error" ? "error" : "skip");
              const statusLabel = ready ? "Ready" : (row.skip_reason || row.status || "Skipped");
              return `
                <tr>
                  <td>
                    <div class="bulk-email-company">${esc(row.company || "Lead")}</div>
                    <div class="bulk-email-meta">${esc(row.list_name || "-")} | ${esc(row.stage || "-")}</div>
                  </td>
                  <td>${esc(row.assigned_to_name || row.assigned_to_email || "-")}</td>
                  <td>
                    <div>${esc(row.recipient_email || "-")}</div>
                    ${row.recipient_contact_name ? `<div class="bulk-email-meta">${esc(row.recipient_contact_name)}</div>` : ""}
                  </td>
                  <td>${row.existing_thread ? '<span class="bulk-email-tag ready">Reply</span>' : '<span class="bulk-email-tag skip">New</span>'}</td>
                  <td>${esc(row.subject_preview || "-")}</td>
                  <td><span class="bulk-email-tag ${statusClass}">${esc(statusLabel)}</span></td>
                  ${showResultColumns ? `<td>${esc(row.message || "-")}</td>` : ""}
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function render() {
    ensureStyles();
    const host = document.getElementById("view-bulk-email");
    if (!host) return;
    const selectedTemplate = currentTemplate();
    const readyCount = Number(counts().ready_to_send || 0);
    const results = state.results || null;
    const summary = results?.summary || {};
    host.innerHTML = `
      <div class="bulk-email-shell">
        <div class="bulk-email-head">
          <div class="bulk-email-head-copy">
            <h2>Bulk Email</h2>
            <p>Send individualized Gmail follow-ups to filtered leads. Existing Gmail threads are reused when available, each email is sent from the assigned SDR’s connected Gmail account, and DNC / no-email / no-Gmail leads are skipped automatically.</p>
          </div>
          <div class="bulk-email-actions">
            <button class="bulk-email-btn secondary" type="button" data-bulk-email-refresh ${state.loading ? "disabled" : ""}>${state.loading ? "Loading..." : "Refresh"}</button>
            <button class="bulk-email-btn secondary" type="button" data-bulk-email-preview ${state.loading || state.previewing ? "disabled" : ""}>${state.previewing ? "Previewing..." : "Preview"}</button>
            <button class="bulk-email-btn primary" type="button" data-bulk-email-send ${state.loading || state.previewing || state.sending || !readyCount ? "disabled" : ""}>${state.sending ? "Sending..." : `Send ${readyCount ? `(${readyCount})` : ""}`}</button>
          </div>
        </div>
        ${state.error ? `<div class="bulk-email-error">${esc(state.error)}</div>` : ""}
        <div class="bulk-email-layout">
          <div class="bulk-email-card">
            <div class="bulk-email-card-head">
              <h3>Filters & Compose</h3>
              <p>Define the lead set, choose a company template or write a custom message, then preview exactly what will happen.</p>
            </div>
            <div class="bulk-email-card-body">
              <div class="bulk-email-grid">
                <div class="bulk-email-field">
                  <label>Stage</label>
                  <select class="bulk-email-select" data-bulk-email-filter="stage">
                    <option value="">All stages</option>
                    ${(Array.isArray(state.bootstrap.stages) ? state.bootstrap.stages : []).map((stage) => {
                      const value = String(stage || "");
                      return `<option value="${esc(value)}" ${value === String(state.filters.stage || "") ? "selected" : ""}>${esc(value)}</option>`;
                    }).join("")}
                  </select>
                </div>
                <div class="bulk-email-field">
                  <label>Assigned SDR</label>
                  <select class="bulk-email-select" data-bulk-email-filter="assigned_to_email">
                    <option value="">All assigned SDRs</option>
                    ${(Array.isArray(state.bootstrap.users) ? state.bootstrap.users : []).map((user) => {
                      const email = String(user?.email || "");
                      const label = String(user?.name || email || "");
                      return `<option value="${esc(email)}" ${email === String(state.filters.assigned_to_email || "") ? "selected" : ""}>${esc(label)}</option>`;
                    }).join("")}
                  </select>
                </div>
                <div class="bulk-email-field full">
                  <label>Lead List</label>
                  <select class="bulk-email-select" data-bulk-email-filter="list_id">
                    <option value="">All lists</option>
                    ${(Array.isArray(state.bootstrap.lists) ? state.bootstrap.lists : []).map((list) => {
                      const id = String(list?.id || "");
                      const label = String(list?.name || id || "");
                      return `<option value="${esc(id)}" ${id === String(state.filters.list_id || "") ? "selected" : ""}>${esc(label)}</option>`;
                    }).join("")}
                  </select>
                </div>
                <div class="bulk-email-field full">
                  <label>Search</label>
                  <input class="bulk-email-input" data-bulk-email-filter="q" value="${esc(state.filters.q || "")}" placeholder="Company, email, phone, or list name">
                </div>
              </div>
              <div class="bulk-email-field">
                <label>Compose Mode</label>
                <div class="bulk-email-mode-row">
                  <button class="bulk-email-mode-btn ${state.composeMode === "template" ? "active" : ""}" type="button" data-bulk-email-mode="template">Use Company Template</button>
                  <button class="bulk-email-mode-btn ${state.composeMode === "custom" ? "active" : ""}" type="button" data-bulk-email-mode="custom">Custom Message</button>
                </div>
              </div>
              ${state.composeMode === "template" ? `
                <div class="bulk-email-field">
                  <label>Company Template</label>
                  <div class="bulk-email-template-chip-row">
                    ${(Array.isArray(state.bootstrap.templates) ? state.bootstrap.templates : []).map((template) => {
                      const id = String(template?.id || "");
                      return `<button class="bulk-email-template-chip ${id === String(state.templateId || "") ? "active" : ""}" type="button" data-bulk-email-template="${esc(id)}">${esc(template?.name || "Template")}</button>`;
                    }).join("")}
                  </div>
                </div>
                <div class="bulk-email-field">
                  <label>Subject Preview</label>
                  <input class="bulk-email-input" value="${esc(selectedTemplate?.subject || "")}" readonly>
                </div>
                <div class="bulk-email-field">
                  <label>Body Preview</label>
                  <textarea class="bulk-email-textarea" readonly>${esc(selectedTemplate?.body || "")}</textarea>
                </div>
                <div class="bulk-email-note">Template variables are resolved per lead at send time, replies reuse the existing Gmail thread when one exists, and the assigned SDR’s Gmail signature is appended automatically.</div>
              ` : `
                <div class="bulk-email-field">
                  <label>Custom Subject</label>
                  <input class="bulk-email-input" data-bulk-email-custom-subject value="${esc(state.customSubject || "")}" placeholder="Subject line">
                </div>
                <div class="bulk-email-field">
                  <label>Custom Body</label>
                  <textarea class="bulk-email-textarea" data-bulk-email-custom-body placeholder="Write the custom email body here. Template variables like {{company}}, {{company_name}}, {{contact_name}}, and {{rep_name}} will still resolve per lead.">${esc(state.customBody || "")}</textarea>
                </div>
              `}
            </div>
          </div>
          <div class="bulk-email-card">
            <div class="bulk-email-card-head">
              <h3>${results ? "Results" : "Preview"}</h3>
              <p>${results ? "The bulk send summary and per-lead outcomes." : "Check exactly which leads will get an email, who they’ll be sent from, and whether the message will reply into an existing Gmail thread."}</p>
            </div>
            <div class="bulk-email-card-body">
              ${renderMetricsHtml()}
              <div class="bulk-email-preview-toolbar">
                <div class="bulk-email-status ${state.error ? "error" : ""}">
                  ${state.loading ? "Loading bulk email configuration..." : state.previewing ? "Building preview..." : state.sending ? "Sending individualized Gmail messages..." : results ? "Bulk email run completed." : "Preview before sending so skips and reply-thread behavior are obvious."}
                </div>
                ${results ? `
                  <div class="bulk-email-results-summary">
                    <span class="bulk-email-pill sent">Sent ${esc(summary.sent ?? 0)}</span>
                    <span class="bulk-email-pill skipped">Skipped ${esc(summary.skipped ?? 0)}</span>
                    <span class="bulk-email-pill error">Errors ${esc(summary.errors ?? 0)}</span>
                  </div>
                ` : ""}
              </div>
              ${renderRows(results ? results.rows : state.preview?.rows, !!results)}
            </div>
          </div>
        </div>
      </div>
    `;
    bind(host);
  }

  window.BulkEmailTab = {
    init() {
      if (state.initialized) return;
      state.initialized = true;
      ensureStyles();
      render();
    },
    async onShow() {
      if (!state.initialized) this.init();
      if (!state.bootstrap.templates.length && !state.loading) {
        await loadBootstrap(false);
        return;
      }
      render();
    },
  };
})();
