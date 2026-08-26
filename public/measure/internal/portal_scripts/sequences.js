(function () {
  if (!window.Portal) return;

  const state = {
    data: null,
    loading: false,
    loaded: false,
    targetMode: "mine",
    targetEmail: "",
  };

  function cfg() {
    return window.Portal.cfg || window.PORTAL_CFG || {};
  }

  function esc(value) {
    return window.Portal.escapeHtml(String(value ?? ""));
  }

  function caps() {
    return cfg().capabilities || {};
  }

  function canManage() {
    return !!caps().manage_sales_users || !!caps().view_all_callers_list_progress;
  }

  function api(payload) {
    return fetch(cfg().endpoints?.server || window.Portal.internalLegacyEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json());
  }

  function fmtDate(ts) {
    const n = Number(ts || 0);
    return n ? new Date(n * 1000).toLocaleString() : "-";
  }

  function injectStyles() {
    if (document.getElementById("sequencesTabStyles")) return;
    const style = document.createElement("style");
    style.id = "sequencesTabStyles";
    style.textContent = `
      .seq-shell{display:grid;gap:18px;padding:4px 0 24px;min-height:0}
      .seq-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
      .seq-head h1{margin:0;font-size:28px;line-height:1.05;color:#1a1f2e;font-weight:900;letter-spacing:-.03em}
      .seq-sub{margin-top:6px;color:#697386;font-size:13px;max-width:760px}
      .seq-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .seq-select{padding:9px 12px;border:1px solid #d5dce8;border-radius:10px;background:#fff;color:#1f2937;min-width:210px}
      .seq-btn{border:none;background:#d93025;color:#fff;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer;display:inline-flex;gap:8px;align-items:center}
      .seq-btn:disabled{opacity:.7;cursor:default}
      .seq-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
      .seq-card{background:linear-gradient(180deg,#fff 0%,#fafbfd 100%);border:1px solid #dbe2ec;border-radius:16px;padding:16px;display:grid;gap:10px}
      .seq-card h3{margin:0;font-size:16px;font-weight:900;color:#1a1f2e}
      .seq-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      .seq-metric{background:#f6f8fb;border:1px solid #ecf0f4;border-radius:12px;padding:10px}
      .seq-metric-label{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;color:#6a7485}
      .seq-metric-value{margin-top:4px;font-size:20px;font-weight:900;color:#1f2937}
      .seq-table-shell{background:#fff;border:1px solid #dbe2ec;border-radius:16px;overflow:hidden}
      .seq-table-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;background:#f8fafc;border-bottom:1px solid #edf1f5}
      .seq-table-head h2{margin:0;font-size:16px;font-weight:900;color:#1a1f2e}
      .seq-table-wrap{overflow:auto}
      .seq-table{width:100%;border-collapse:collapse}
      .seq-table th,.seq-table td{padding:12px 14px;border-bottom:1px solid #edf1f5;text-align:left;font-size:13px;vertical-align:middle}
      .seq-table th{background:#fbfcfe;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;color:#647084;white-space:nowrap}
      .seq-row-btn{border:none;background:none;padding:0;color:#1a1f2e;font:inherit;font-weight:800;cursor:pointer}
      .seq-row-btn:hover{color:#d93025}
      .seq-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:800}
      .seq-badge.active{background:#e8f0fe;color:#1a6bd9}
      .seq-badge.paused{background:#fef3e0;color:#b45309}
      .seq-badge.completed{background:#e7f5eb;color:#137333}
      .seq-badge.stopped{background:#f3f4f6;color:#4b5563}
      .seq-empty,.seq-loading{padding:20px;color:#7a8594}
      @media (max-width:1280px){.seq-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media (max-width:760px){.seq-summary{grid-template-columns:minmax(0,1fr)}}
    `;
    document.head.appendChild(style);
  }

  function ensureDefaults() {
    if (canManage()) {
      if (!state.targetMode || (state.targetMode === "mine" && !state.loaded)) state.targetMode = "all";
    } else {
      state.targetMode = "mine";
      state.targetEmail = "";
    }
  }

  function targetPayload() {
    return {
      target_mode: state.targetMode,
      target_email: state.targetMode === "user" ? state.targetEmail : "",
    };
  }

  async function openLead(leadId) {
    const id = String(leadId || "").trim();
    if (!id) return;
    if (window.LeadWorkspace?.openLead) {
      await window.LeadWorkspace.openLead(id, {
        sourceView: "sequences",
        sourceNavId: "nav-sequences",
      });
      return;
    }
    if (window.Leads?.openLeadById) {
      await window.Leads.openLeadById(id, {
        sourceView: "sequences",
        sourceNavId: "nav-sequences",
      });
    }
  }

  async function load() {
    ensureDefaults();
    state.loading = true;
    render();
    try {
      const data = await api({
        action: "lead_sequences_snapshot",
        ...targetPayload(),
      });
      if (!data?.success) throw new Error(data?.error || "Could not load sequences.");
      state.data = data;
      state.loaded = true;
    } catch (err) {
      if (window.Portal?.notify) window.Portal.notify(err?.message || "Could not load sequences.", "error");
    } finally {
      state.loading = false;
      render();
    }
  }

  function targetOptions() {
    const users = Array.isArray(state.data?.sales_users) ? state.data.sales_users : [];
    const opts = ['<option value="all">All SDRs</option>', '<option value="mine">My Leads</option>'];
    users.forEach((user) => {
      const email = String(user?.email || "").trim();
      if (!email) return;
      opts.push(`<option value="user:${esc(email)}">${esc(String(user?.name || email))}</option>`);
    });
    return opts.join("");
  }

  function statusBadge(status) {
    const normalized = String(status || "").toLowerCase();
    const cls = ["active", "paused", "completed", "stopped"].includes(normalized) ? normalized : "stopped";
    return `<span class="seq-badge ${cls}">${esc(normalized || "unknown")}</span>`;
  }

  function renderSummaryCard(row) {
    return `
      <section class="seq-card">
        <h3>${esc(row?.label || "Sequence")}</h3>
        <div class="seq-metrics">
          <div class="seq-metric"><div class="seq-metric-label">Total</div><div class="seq-metric-value">${Number(row?.total || 0)}</div></div>
          <div class="seq-metric"><div class="seq-metric-label">Active</div><div class="seq-metric-value">${Number(row?.active || 0)}</div></div>
          <div class="seq-metric"><div class="seq-metric-label">Paused</div><div class="seq-metric-value">${Number(row?.paused || 0)}</div></div>
          <div class="seq-metric"><div class="seq-metric-label">Completed</div><div class="seq-metric-value">${Number(row?.completed || 0)}</div></div>
        </div>
      </section>
    `;
  }

  function render() {
    const root = document.getElementById("sequencesRoot");
    if (!root) return;
    if (!state.loaded && state.loading) {
      root.innerHTML = '<div class="seq-loading">Loading sequences...</div>';
      return;
    }
    const summary = Array.isArray(state.data?.summary) ? state.data.summary : [];
    const rows = Array.isArray(state.data?.rows) ? state.data.rows : [];
    root.innerHTML = `
      <div class="seq-shell">
        <div class="seq-head">
          <div>
            <h1>Sequences & Campaigns</h1>
            <div class="seq-sub">Hardcoded SDR campaigns are now tracked centrally here, with live enrollment status, pause reasons, and direct drill-in back to the lead.</div>
          </div>
          <div class="seq-actions">
            ${canManage() ? `<select class="seq-select" id="sequencesTargetSelect">${targetOptions()}</select>` : ""}
            <button type="button" class="seq-btn" id="sequencesRefreshBtn" ${state.loading ? "disabled" : ""}>
              <i class="fas ${state.loading ? "fa-spinner fa-spin" : "fa-rotate-right"}"></i>
              ${state.loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
        <div class="seq-summary">
          ${summary.length ? summary.map(renderSummaryCard).join("") : '<div class="seq-empty">No sequence enrollments match this view yet.</div>'}
        </div>
        <section class="seq-table-shell">
          <div class="seq-table-head">
            <h2>Enrollment Detail</h2>
            <div>${rows.length ? `${rows.length} rows` : "No active data"}</div>
          </div>
          <div class="seq-table-wrap">
            <table class="seq-table">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Sequence</th>
                  <th>Status</th>
                  <th>Next Step</th>
                  <th>Pause Reason</th>
                  <th>Assigned SDR</th>
                  <th>Stage</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                ${
                  rows.length
                    ? rows
                        .map(
                          (row) => `
                    <tr>
                      <td><button type="button" class="seq-row-btn" data-open-lead="${esc(row.lead_id)}">${esc(row.company || "Lead")}</button></td>
                      <td>${esc(row.sequence_label || row.sequence_key || "Sequence")}</td>
                      <td>${statusBadge(row.status)}</td>
                      <td>${esc(row.next_step || "-")}</td>
                      <td>${esc(row.pause_reason || "-")}</td>
                      <td>${esc(row.assigned_to_name || row.assigned_to_email || "Unassigned")}</td>
                      <td>${esc(row.lead_status || "-")}</td>
                      <td>${esc(fmtDate(row.updated_at))}</td>
                    </tr>`
                        )
                        .join("")
                    : '<tr><td colspan="8" class="seq-empty">No sequence enrollments match this view yet.</td></tr>'
                }
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `;
    const targetSelect = document.getElementById("sequencesTargetSelect");
    if (targetSelect) {
      const current = state.targetMode === "user" && state.targetEmail ? `user:${state.targetEmail}` : state.targetMode;
      targetSelect.value = current;
    }
  }

  function bindEvents() {
    const root = document.getElementById("sequencesRoot");
    if (!root || root._sequencesBound) return;
    root._sequencesBound = true;
    root.addEventListener("click", async (event) => {
      const leadBtn = event.target.closest("[data-open-lead]");
      if (leadBtn) {
        await openLead(leadBtn.getAttribute("data-open-lead"));
        return;
      }
      const refreshBtn = event.target.closest("#sequencesRefreshBtn");
      if (refreshBtn) await load();
    });
    root.addEventListener("change", async (event) => {
      const select = event.target.closest("#sequencesTargetSelect");
      if (!select) return;
      const value = String(select.value || "");
      if (value === "all") {
        state.targetMode = "all";
        state.targetEmail = "";
      } else if (value === "mine") {
        state.targetMode = "mine";
        state.targetEmail = "";
      } else if (value.startsWith("user:")) {
        state.targetMode = "user";
        state.targetEmail = value.slice(5);
      }
      await load();
    });
  }

  const SequencesTab = {
    init() {
      injectStyles();
      bindEvents();
      ensureDefaults();
    },
    async onShow() {
      bindEvents();
      if (!state.loaded) await load();
      else {
        render();
        load();
      }
    },
  };

  window.SequencesTab = SequencesTab;
})();
