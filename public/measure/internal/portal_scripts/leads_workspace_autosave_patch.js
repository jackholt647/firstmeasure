(function () {
  if (!window.Portal || !window.Leads) return;

  function leadWorkspaceIsActive() {
    return !!document.getElementById("leadWorkspace")?.classList.contains("active");
  }

  function getLeadWorkspaceController() {
    return document.getElementById("leadDetailBody")?.__leadViewerController || null;
  }

  const originalCloseLeadWorkspace =
    typeof window.Leads.closeLeadWorkspace === "function"
      ? window.Leads.closeLeadWorkspace.bind(window.Leads)
      : null;

  if (originalCloseLeadWorkspace) {
    window.Leads.closeLeadWorkspace = async function (options) {
      if (leadWorkspaceIsActive()) {
        const canClose = await getLeadWorkspaceController()?.flushPendingChanges?.();
        if (canClose === false) return false;
      }
      originalCloseLeadWorkspace(options);
      return true;
    };
  }

  document.addEventListener(
    "click",
    (event) => {
      const backTrigger = event.target.closest(
        "#leadWorkspaceBackBtn,[data-lead-page-back]",
      );
      if (!backTrigger || !leadWorkspaceIsActive()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve(window.Leads.closeLeadWorkspace?.()).catch(() => ({}));
    },
    true,
  );

  const previousSwitchView =
    typeof window.Portal.switchView === "function"
      ? window.Portal.switchView.bind(window.Portal)
      : null;

  if (previousSwitchView) {
    window.Portal.switchView = async function (id, btn) {
      if (id !== "leads" && leadWorkspaceIsActive()) {
        const closed = await window.Leads.closeLeadWorkspace?.({
          skipReturn: true,
        });
        if (closed === false) return false;
      }
      return previousSwitchView(id, btn);
    };
  }
})();
