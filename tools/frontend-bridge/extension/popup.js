// FirstMate Dev Bridge popup: shows what the background worker published and edits the local settings.
const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ALL = { origins: ["<all_urls>"] };

async function render() {
  const { view = {} } = await chrome.storage.session.get("view");
  const settings = await chrome.storage.local.get({ port: 5747, enabled: true, autoReload: true });
  const files = view.files || [];
  const pending = view.pending_deploy || [];
  $("state").textContent = !view.connected ? "Bridge not running" : !settings.enabled || view.paused ? "Off" : `${files.length} local file${files.length === 1 ? "" : "s"}`;
  $("state").className = `state${view.connected ? "" : " down"}`;
  $("summary").innerHTML = view.connected
    ? `<div>Serving from <code>${esc(view.root || "")}</code></div><div class="muted">Base ${esc(String(view.base || "").slice(0, 10))}${view.paused ? " · paused by the bridge" : ""}${view.stale ? " · reload to see the latest change" : ""}</div>`
    : `<div>Start the bridge in your checkout:</div><div style="margin-top:4px"><code>node tools/frontend-bridge/bridge.mjs serve</code></div><div class="muted" style="margin-top:4px">This popup connects within 30 seconds, or press Reconnect.</div>`;
  $("files").hidden = !files.length;
  const missing = new Set(view.missing || []);
  $("file-list").innerHTML = files.map((file) => `<li>/${esc(file.path)}${missing.has(file.path) ? "<small>Not in this extension's folder: start the bridge with --extension pointing at the folder you loaded</small>" : file.drift === "dev-differs" ? "<small>Dev has a different version than your base</small>" : ""}</li>`).join("");
  $("pending").hidden = !pending.length;
  $("pending-list").innerHTML = pending.map((entry) => `<li>${esc(entry.path)}</li>`).join("");
  $("enabled").checked = settings.enabled;
  $("autoReload").checked = settings.autoReload;
  if (document.activeElement !== $("port")) $("port").value = settings.port;
  $("shots-row").hidden = await chrome.permissions.contains(ALL);
}

$("enabled").addEventListener("change", (event) => chrome.storage.local.set({ enabled: event.target.checked }));
$("autoReload").addEventListener("change", (event) => chrome.storage.local.set({ autoReload: event.target.checked }));
$("port").addEventListener("change", (event) => { const port = Number(event.target.value); if (port >= 1024 && port <= 65535) chrome.storage.local.set({ port }); });
$("reload").addEventListener("click", () => chrome.runtime.sendMessage({ type: "fmb:reloadTabs" }));
$("reconnect").addEventListener("click", () => chrome.runtime.sendMessage({ type: "fmb:reconnect" }).then(render));
$("shots").addEventListener("click", () => chrome.permissions.request(ALL).then(render));
chrome.storage.onChanged.addListener(render);
render();
