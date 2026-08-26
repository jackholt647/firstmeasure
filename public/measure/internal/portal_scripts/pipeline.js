(function () {
  if (!window.Portal) return;

  const state = {
    data: null,
    loading: false,
    loaded: false,
    targetMode: "mine",
    targetEmail: "",
    viewActive: false,
  };

  function cfg() {
    return window.Portal.cfg || window.PORTAL_CFG || {};
  }

  function esc(value) {
    return window.Portal.escapeHtml(String(value ?? ""));
  }

  function canManage() {
    const perms = cfg().perms || {};
    const role = String(cfg().user?.role || "").toLowerCase();
    return !!(
      perms.manage_users ||
      perms.manage_sales_users ||
      perms.create_users ||
      role === "admin" ||
      role === "system_admin" ||
      role === "sales_manager"
    );
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
    if (document.getElementById("pipelineTabStyles")) return;
    const style = document.createElement("style");
    style.id = "pipelineTabStyles";
    style.textContent = `
      #view-pipeline{height:100%;min-height:0;overflow:hidden}
      #pipelineRoot{height:100%;min-height:0;overflow:hidden}
      .pipe-shell{display:grid;grid-template-rows:auto minmax(0,1fr);gap:18px;padding:4px 0 10px;min-height:0;height:100%;box-sizing:border-box;overflow:hidden}
      .pipe-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
      .pipe-head h1{margin:0;font-size:28px;line-height:1.05;color:#1a1f2e;font-weight:900;letter-spacing:-.03em}
      .pipe-sub{margin-top:6px;color:#697386;font-size:13px}
      .pipe-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .pipe-select,.pipe-btn{font:inherit}
      .pipe-select{padding:9px 12px;border:1px solid #d5dce8;border-radius:10px;background:#fff;color:#1f2937;min-width:210px}
      .pipe-btn{border:none;background:#d93025;color:#fff;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer;display:inline-flex;gap:8px;align-items:center}
      .pipe-btn.secondary{background:#fff;color:#435168;border:1px solid #d5dce8}
      .pipe-btn:disabled{opacity:.7;cursor:default}
      .pipe-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;align-items:stretch;min-height:0;height:100%;overflow:hidden}
      .pipe-col{background:#fff;border:1px solid #dbe2ec;border-radius:16px;overflow:hidden;min-height:0;display:flex;flex-direction:column}
      .pipe-col-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:13px 14px;background:#f8fafc;border-bottom:1px solid #edf1f5}
      .pipe-col-title{font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:#556275}
      .pipe-col-count{min-width:28px;height:28px;border-radius:999px;background:#eef2f7;color:#233246;font-size:12px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;padding:0 8px}
      .pipe-col-body{padding:12px;display:grid;gap:10px;min-height:0;overflow:auto;flex:1}
      .pipe-card{border:1px solid #e5e9f0;background:linear-gradient(180deg,#fff 0%,#fbfcfe 100%);border-radius:14px;padding:12px;display:grid;gap:8px;cursor:pointer;text-align:left}
      .pipe-card:hover{border-color:#d93025;box-shadow:0 0 0 2px rgba(217,48,37,.08)}
      .pipe-card-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
      .pipe-card-company{font-size:14px;font-weight:900;color:#1a1f2e;line-height:1.2}
      .pipe-card-seq{font-size:10px;font-weight:900;color:#7c3aed;background:#f3e8ff;border:1px solid #e4d4ff;border-radius:999px;padding:3px 7px;white-space:nowrap}
      .pipe-card-meta{display:grid;gap:4px;font-size:11px;color:#5e6a7b}
      .pipe-card-meta strong{color:#243041}
      .pipe-empty{padding:18px 12px;color:#8b95a8;text-align:center;font-style:italic}
      .pipe-loading{padding:22px;color:#6b7280}
      @media (max-width:1500px){.pipe-board{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media (max-width:1180px){.pipe-board{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media (max-width:760px){.pipe-board{grid-template-columns:minmax(0,1fr)}}
    `;
    document.head.appendChild(style);
  }

  async function openLead(leadId) {
    const id = String(leadId || "").trim();
    if (!id) return;
    if (window.LeadWorkspace?.openLead) {
      await window.LeadWorkspace.openLead(id, {
        sourceView: "pipeline",
        sourceNavId: "nav-pipeline",
      });
      return;
    }
    if (window.Leads?.openLeadById) {
      await window.Leads.openLeadById(id, {
        sourceView: "pipeline",
        sourceNavId: "nav-pipeline",
      });
    }
  }

  function targetPayload() {
    return {
      target_mode: state.targetMode,
      target_email: state.targetMode === "user" ? state.targetEmail : "",
    };
  }

  function ensureTargetDefaults() {
    if (canManage()) {
      if (!state.targetMode || state.targetMode === "mine" && !state.loaded) state.targetMode = "all";
    } else {
      state.targetMode = "mine";
      state.targetEmail = "";
    }
  }

  async function load(options) {
    const opts = options || {};
    ensureTargetDefaults();
    state.loading = true;
    render();
    try {
      const data = await api({
        action: "lead_pipeline_snapshot",
        ...targetPayload(),
      });
      if (!data?.success) throw new Error(data?.error || "Could not load pipeline.");
      state.data = data;
      state.loaded = true;
    } catch (err) {
      if (window.Portal?.notify) window.Portal.notify(err?.message || "Could not load pipeline.", "error");
    } finally {
      state.loading = false;
      if (!opts.silent || state.viewActive) render();
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

  function renderColumn(column) {
    const rows = Array.isArray(column?.leads) ? column.leads : [];
    return `
      <section class="pipe-col">
        <div class="pipe-col-head">
          <div class="pipe-col-title">${esc(column?.label || "Stage")}</div>
          <div class="pipe-col-count">${Number(column?.count || 0)}</div>
        </div>
        <div class="pipe-col-body">
          ${
            rows.length
              ? rows
                  .map(
                    (row) => `
              <button type="button" class="pipe-card" data-open-lead="${esc(row.lead_id)}">
                <div class="pipe-card-top">
                  <div class="pipe-card-company">${esc(row.company || "Lead")}</div>
                  ${row?.active_sequence ? `<span class="pipe-card-seq">${esc(String(row.active_sequence.sequence_label || row.active_sequence.sequence_key || "Sequence"))}</span>` : ""}
                </div>
                <div class="pipe-card-meta">
                  <div><strong>${esc(row.assigned_to_name || row.assigned_to_email || "Unassigned")}</strong></div>
                  <div>${esc(row.list_name || "-")}</div>
                  <div>${esc([row.city, row.state].filter(Boolean).join(", ") || "-")}</div>
                  <div>Updated ${esc(fmtDate(row.updated_at))}</div>
                  ${Number(row.next_followup_at || 0) > 0 ? `<div>Next follow-up ${esc(fmtDate(row.next_followup_at))}</div>` : ""}
                </div>
              </button>`
                  )
                  .join("")
              : '<div class="pipe-empty">No leads in this stage.</div>'
          }
        </div>
      </section>
    `;
  }

  function render() {
    const root = document.getElementById("pipelineRoot");
    if (!root) return;
    if (!state.loaded && state.loading) {
      root.innerHTML = '<div class="pipe-loading">Loading pipeline...</div>';
      return;
    }
    const columns = Array.isArray(state.data?.columns) ? state.data.columns : [];
    root.innerHTML = `
      <div class="pipe-shell">
        <div class="pipe-head">
          <div>
            <h1>Pipeline</h1>
            <div class="pipe-sub">Stage-by-stage view of active leads, with direct lead opening and current campaign visibility.</div>
          </div>
          <div class="pipe-actions">
            ${
              canManage()
                ? `<select class="pipe-select" id="pipelineTargetSelect">${targetOptions()}</select>`
                : ""
            }
            <button type="button" class="pipe-btn ${state.loading ? "secondary" : ""}" id="pipelineRefreshBtn" ${state.loading ? "disabled" : ""}>
              <i class="fas ${state.loading ? "fa-spinner fa-spin" : "fa-rotate-right"}"></i>
              ${state.loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
        <div class="pipe-board">
          ${columns.map(renderColumn).join("")}
        </div>
      </div>
    `;
    const targetSelect = document.getElementById("pipelineTargetSelect");
    if (targetSelect) {
      const current = state.targetMode === "user" && state.targetEmail ? `user:${state.targetEmail}` : state.targetMode;
      targetSelect.value = current;
    }
  }

  function bindEvents() {
    const root = document.getElementById("pipelineRoot");
    if (!root || root._pipelineBound) return;
    root._pipelineBound = true;
    root.addEventListener("click", async (event) => {
      const leadBtn = event.target.closest("[data-open-lead]");
      if (leadBtn) {
        await openLead(leadBtn.getAttribute("data-open-lead"));
        return;
      }
      const refreshBtn = event.target.closest("#pipelineRefreshBtn");
      if (refreshBtn) {
        await load();
      }
    });
    root.addEventListener("change", async (event) => {
      const select = event.target.closest("#pipelineTargetSelect");
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

  const PipelineTab = {
    init() {
      injectStyles();
      bindEvents();
      ensureTargetDefaults();
    },
    async onShow() {
      state.viewActive = true;
      bindEvents();
      if (!state.loaded) await load();
      else {
        render();
        load();
      }
    },
    async refresh() {
      await load();
    },
  };

  window.PipelineTab = PipelineTab;
})();
