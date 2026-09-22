(function(){
  'use strict';

  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerApp) return;

  function mount(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return {};
    const navigation = window.Portal?.navigation;
    const feedback = window.FirstMateFeedbackSettings;
    const view = (route = {}) => ['delivery', 'workflow', 'responses'].includes(route.feedbackView) ? route.feedbackView : 'responses';
    const host = document.createElement('div');
    host.style.cssText = 'padding:24px;max-width:1600px;margin:0 auto;width:100%;box-sizing:border-box';
    root.appendChild(host);
    feedback.mount(host, {
      orgId: context.orgId || window.__APP?.userOrgId || window.__APP?.orgId,
      branchId: context.branchId || window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default',
      initialView: view(navigation?.read?.()),
      showToast: (title, detail, ok) => {
        const ui = window.Portal?.ui || window.PlatformUI;
        ui?.showToast?.(title, detail, ok);
      },
      onViewChange: (next) => {
        if (!navigation?.applying) navigation?.push?.({ tab:'feedback', feedbackView:next }, { source:'feedback-view', ownedKeys:['feedbackView'] });
      }
    });
    const unregisterRoute = navigation?.registerHandler?.(`feedback-view:${context.instanceId || 'main'}`, {
      priority:400,
      apply: (route) => {
        if (route.tab === 'feedback') feedback.setView(host, view(route));
      }
    });
    return {
      destroy(){
        unregisterRoute?.();
        feedback.destroy?.(host);
        host.remove();
      }
    };
  }

  runtime.registerApp({
    id:'portal.feedback', package:'feedback', kind:'portal_tab',
    title:(globalThis.PlatformLanguage?.text("feedback","m_d77e00c8c3f0b8","Feedback") ?? "Feedback"), label:(globalThis.PlatformLanguage?.text("feedback","m_d77e00c8c3f0b8","Feedback") ?? "Feedback"), icon:'fa-star', order:56,
    surfaces:['portal_tab'], regions:['main'], visible:true,
    access:{ applicationsAny:['management'], capability:'apps.feedback' },
    mount
  });
})();
