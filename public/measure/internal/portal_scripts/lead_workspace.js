(function () {
  if (!window.Portal || !window.LeadViewer) return;

  function api(data) {
    return fetch(window.Portal.cfg?.endpoints?.server || window.Portal.internalLegacyEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {}),
    }).then((res) => res.json());
  }

  const esc = (value) => window.Portal.escapeHtml(String(value ?? ""));
  const host = document.getElementById("globalLeadWorkspace");
  const bodyEl = document.getElementById("globalLeadWorkspaceBody");
  if (!host || !bodyEl) return;

  const state = {
    active: false,
    sourceView: "",
  };

  const controller = window.LeadViewer.createController({
    bodyEl,
    api,
    esc,
    onBack() {
      LeadWorkspace.close();
    },
    onUpdated() {},
  });

  function setActive(active) {
    state.active = !!active;
    host.classList.toggle("active", state.active);
    host.setAttribute("aria-hidden", state.active ? "false" : "true");
  }

  const previousSwitchView = window.Portal.switchView
    ? window.Portal.switchView.bind(window.Portal)
    : null;

  if (previousSwitchView) {
    window.Portal.switchView = async function (id, btn) {
      if (state.active) {
        const closed = await LeadWorkspace.close({ keepUnderlyingView: true });
        if (closed === false) return false;
      }
      return previousSwitchView(id, btn);
    };
  }

  const LeadWorkspace = {
    async openLead(leadId, options) {
      const id = String(leadId || "").trim();
      if (!id) return;
      const opts = options && typeof options === "object" ? options : {};
      state.sourceView = String(opts.sourceView || "");
      setActive(true);
      await controller.loadLead(id, {
        resetTransient: true,
        silent: false,
        forceRingCentralSync: true,
      });
    },
    async close() {
      const canClose = await controller.flushPendingChanges?.();
      if (canClose === false) return false;
      controller.clear();
      state.sourceView = "";
      setActive(false);
      return true;
    },
    isOpen() {
      return state.active;
    },
    getLead() {
      return controller.getLead();
    },
  };

  window.LeadWorkspace = LeadWorkspace;
})();
