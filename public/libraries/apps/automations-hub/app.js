/* public/libraries/apps/automations-hub/app.js
 * The Automations Hub (portal.automations_hub, GP-72): one big settings page for everything that happens
 * automatically along a pipeline, stage by stage. A placeholder for now; what it will hold is being designed.
 * It is in More apps and not pinned to the left column by default; Checklist settings' "See Advanced Controls"
 * (apps/checklists/app.js) brings people here from a project window.
 */
(function(){
  'use strict';

  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerApp) return;

  const css = `
    .fmah{height:100%;min-height:0;overflow:auto;overscroll-behavior:contain;background:#f5f7fa;color:#101828;box-sizing:border-box;padding:32px 24px}
    .fmah-page{max-width:880px;margin:0 auto;display:grid;gap:22px}
    .fmah-hero{border:1px solid rgba(15,23,42,.085);border-radius:18px;background:#fff;box-shadow:0 10px 26px rgba(15,23,42,.05);padding:28px;display:grid;grid-template-columns:auto 1fr;gap:18px;align-items:center}
    .fmah-mark{width:56px;height:56px;border-radius:16px;background:rgba(var(--primary-rgb,217,48,37),.1);color:var(--primary-readable,var(--primary,#d93025));display:grid;place-items:center;font-size:22px}
    .fmah-hero h1{margin:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:22px;font-weight:1000;letter-spacing:-.01em}
    .fmah-pill{display:inline-flex;align-items:center;height:22px;padding:0 10px;border-radius:999px;background:#fffaeb;color:#b54708;font-size:10px;font-weight:950;letter-spacing:.03em;text-transform:uppercase}
    .fmah-hero p{margin:6px 0 0;color:#475467;font-size:13px;font-weight:750;line-height:1.5}
    .fmah-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
    .fmah-card{border:1px dashed #d0d5dd;border-radius:14px;background:#fff;padding:16px;display:grid;gap:8px;align-content:start}
    .fmah-card i{width:34px;height:34px;border-radius:10px;background:#f2f4f7;color:#475467;display:grid;place-items:center;font-size:13px}
    .fmah-card strong{font-size:13px;font-weight:1000}
    .fmah-card span{color:#667085;font-size:11px;font-weight:750;line-height:1.45}
    @media(max-width:820px){.fmah{padding:12px}.fmah-hero{grid-template-columns:1fr;padding:18px}.fmah-mark{display:none}.fmah-hero h1{font-size:17px}.fmah-cards{grid-template-columns:1fr}}
  `;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[c]);

  function mount(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return {};
    (window.Portal?.util?.injectCSS || ((id, text) => {
      let style = document.getElementById(`css_${id}`);
      if (!style) { style = document.createElement('style'); style.id = `css_${id}`; document.head.appendChild(style); }
      style.textContent = text;
    }))('automations_hub', css);
    const cards = [
      { icon:'fa-list-check', title:(globalThis.PlatformLanguage?.text("automations-hub","m_33c5a083d85018","Stage checklists") ?? "Stage checklists"), description:(globalThis.PlatformLanguage?.text("automations-hub","m_7348ac2bb6f314","Which default checklists a project gets, and at which stage of each pipeline.") ?? "Which default checklists a project gets, and at which stage of each pipeline.") },
      { icon:'fa-bolt', title:(globalThis.PlatformLanguage?.text("automations-hub","m_d55a6b90d72ddf","Stage automations") ?? "Stage automations"), description:(globalThis.PlatformLanguage?.text("automations-hub","m_bc78e1e52a9471","What happens when a project reaches a stage: to-dos, documents, messages and more.") ?? "What happens when a project reaches a stage: to-dos, documents, messages and more.") },
      { icon:'fa-diagram-project', title:(globalThis.PlatformLanguage?.text("automations-hub","m_3d2ee10c8043b7","Every pipeline") ?? "Every pipeline"), description:(globalThis.PlatformLanguage?.text("automations-hub","m_dec132b00d9c95","All of your pipelines and their stages, set up from one place.") ?? "All of your pipelines and their stages, set up from one place.") }
    ];
    const host = document.createElement('div');
    host.className = 'fmah';
    host.setAttribute('data-fm-automations-hub', '');
    host.innerHTML = `<div class="fmah-page">
      <section class="fmah-hero"><span class="fmah-mark"><i class="fas fa-diagram-project" aria-hidden="true"></i></span><div>
        <h1><span>${(globalThis.PlatformLanguage?.htmlText("automations-hub","m_a677e3388e9b31","Automations Hub") ?? "Automations Hub")}</span><span class="fmah-pill">${(globalThis.PlatformLanguage?.htmlText("automations-hub","m_9011dd5d1fb41c","Coming soon") ?? "Coming soon")}</span></h1>
        <p>${(globalThis.PlatformLanguage?.htmlText("automations-hub","m_ebe9355ae447d7","Set up everything that happens automatically as projects move through your pipelines, stage by stage. We are building it now.") ?? "Set up everything that happens automatically as projects move through your pipelines, stage by stage. We are building it now.")}</p>
      </div></section>
      <div class="fmah-cards">${cards.map((card) => `<div class="fmah-card"><i class="fas ${esc(card.icon)}" aria-hidden="true"></i><strong>${esc(card.title)}</strong><span>${esc(card.description)}</span></div>`).join('')}</div>
    </div>`;
    root.appendChild(host);
    return { destroy(){ host.remove(); } };
  }

  runtime.registerApp({
    id:'portal.automations_hub', package:'automations-hub', kind:'portal_tab',
    title:(globalThis.PlatformLanguage?.text("automations-hub","m_a677e3388e9b31","Automations Hub") ?? "Automations Hub"), label:(globalThis.PlatformLanguage?.text("automations-hub","m_a677e3388e9b31","Automations Hub") ?? "Automations Hub"), icon:'fa-diagram-project', order:62,
    surfaces:['portal_tab'], regions:['main'], visible:true, fullBleed:true,
    access:{ capability:'apps.projects' },
    mount
  });
})();
