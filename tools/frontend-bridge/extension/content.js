// FirstMate Dev Bridge: the "Local code" pill on dev.1m8.ai, so nobody mistakes local files for what dev serves.
// Top frame only. Shadow DOM, ignored by session replay (data-fmr-ignore).
(() => {
  if (window.top !== window) return;
  let host = null, root = null, open = false, view = null;

  const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const css = `
    :host{all:initial}
    .wrap{position:fixed;right:12px;bottom:12px;z-index:2147483646;font:12px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#101828}
    .pill{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:999px;background:#1d4ed8;color:#fff;font:inherit;font-weight:650;padding:5px 11px 5px 9px;box-shadow:0 6px 20px rgba(16,24,40,.28);cursor:pointer}
    .pill.off{background:#475467}.pill.stale{background:#b54708}
    .dot{width:7px;height:7px;border-radius:50%;background:#86efac;box-shadow:0 0 0 2px rgba(255,255,255,.25)}
    .off .dot{background:#d0d5dd}
    .panel{position:absolute;right:0;bottom:38px;width:min(380px,calc(100vw - 24px));max-height:min(60vh,480px);overflow:auto;background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 18px 50px rgba(16,24,40,.25);padding:10px 12px}
    h4{margin:6px 0;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#667085}
    ul{margin:0 0 6px;padding:0;list-style:none}
    li{padding:4px 0;border-top:1px solid #f2f4f7;font:11.5px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}
    li small{display:block;font-family:system-ui,sans-serif;color:#b54708}
    .row{display:flex;gap:6px;margin-top:8px}
    .row button{flex:1;border:1px solid #d0d5dd;border-radius:8px;background:#fff;font:inherit;font-weight:600;padding:5px 8px;cursor:pointer;color:#344054}
    p{margin:4px 0;color:#475467}
    p.root{margin:0 0 6px;font:11px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}
  `;

  function render() {
    const files = view?.files || [];
    const show = view?.connected && files.length;
    if (!show) { host?.remove(); host = null; return; }
    if (!host) {
      host = document.createElement("firstmate-dev-bridge");
      host.setAttribute("data-fmr-ignore", "");
      root = host.attachShadow({ mode: "closed" });
      root.addEventListener("click", onClick);
      (document.body || document.documentElement).appendChild(host);
    }
    const off = !view.enabled || view.paused;
    const label = off ? "Local code off" : view.stale ? `Local code · ${files.length} · reload` : `Local code · ${files.length}`;
    const pending = view.pending_deploy || [];
    root.innerHTML = `<style>${css}</style><div class="wrap">
      ${open ? `<div class="panel">
        <h4>${off ? "Would serve from" : "Served from"}</h4><p class="root">${esc(view.root || "your checkout")}</p>
        <ul>${files.map((file) => `<li>/${esc(file.path)}${file.drift === "dev-differs" ? "<small>Dev has a different version than your base</small>" : ""}</li>`).join("")}</ul>
        ${pending.length ? `<h4>Needs a dev rollout to see</h4><ul>${pending.map((entry) => `<li>${esc(entry.path)}</li>`).join("")}</ul>` : ""}
        <p>Everything else is dev's own code. Saving a file reloads this page.</p>
        <div class="row"><button data-act="toggle">${view.enabled ? "Use dev's files" : "Use local files"}</button><button data-act="reload">Reload</button></div>
      </div>` : ""}
      <button class="pill${off ? " off" : view.stale ? " stale" : ""}" data-act="open" title="FirstMate Dev Bridge"><span class="dot"></span>${esc(label)}</button>
    </div>`;
  }

  function onClick(event) {
    const act = event.target.closest?.("[data-act]")?.dataset.act;
    if (act === "open") { open = !open; render(); }
    if (act === "reload") chrome.runtime.sendMessage({ type: "fmb:reloadTabs" });
    if (act === "toggle") chrome.runtime.sendMessage({ type: "fmb:setEnabled", enabled: !view.enabled });
  }

  chrome.runtime.onMessage.addListener((message) => { if (message?.type === "fmb:view") { view = message.view; render(); } });
  const start = () => chrome.runtime.sendMessage({ type: "fmb:getView" }).then((value) => { view = value; render(); }, () => {});
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();
