// FirstMate Dev Bridge: background service worker (docs/architecture/frontend-bridge.md).
//
// Holds one WebSocket to the local bridge (tools/frontend-bridge/bridge.mjs serve). The bridge says which
// browser files differ from dev and copies them into this extension's overrides/ folder; this worker redirects
// dev.1m8.ai's requests for exactly those files to those copies with session rules, swaps stylesheets or reloads
// the dev tabs when they change, and runs the bridge's page commands. Pages never load anything from loopback:
// Chrome's Local Network Access refuses that, redirected or not.

const PROTOCOL = 1;
/** The only site this extension acts on. Production is never touched. */
const SITE = "https://dev.1m8.ai";
const SITE_HOST = "dev.1m8.ai";
const DEFAULTS = { port: 5747, enabled: true, autoReload: true };
const RESOURCE_TYPES = ["script", "stylesheet", "xmlhttprequest", "image", "font", "media", "other"];

let socket = null;
let bridge = null;
/** Rule id -> overridden path, for reporting which overrides pages actually loaded. */
let rulePaths = new Map();

const settings = () => chrome.storage.local.get(DEFAULTS);
const siteTabs = async () => (await chrome.tabs.query({ url: `${SITE}/*` })).map((tab) => ({ id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title, active: tab.active, lastAccessed: tab.lastAccessed }));
const send = (message) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------
// What the popup and the page badge show

async function publish(patch) {
  const { view = {} } = await chrome.storage.session.get("view");
  const next = { ...view, ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ view: next });
  const count = next.connected && next.enabled && !next.paused ? (next.files || []).length : 0;
  await chrome.action.setBadgeText({ text: !next.connected ? "" : next.paused || !next.enabled ? "off" : count ? String(count) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: next.stale ? "#d97706" : "#1d4ed8" });
  await chrome.action.setTitle({ title: !next.connected ? "FirstMate Dev Bridge: bridge not running" : `FirstMate Dev Bridge: ${count} local file${count === 1 ? "" : "s"} on ${SITE_HOST}` });
  for (const tab of await siteTabs()) chrome.tabs.sendMessage(tab.id, { type: "fmb:view", view: next }, { frameId: 0 }).catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Redirect rules

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const encodePath = (rel) => rel.split("/").map(encodeURIComponent).join("/");

const overridePath = (file) => `/overrides/${file.rev}/${file.path}`;

/** The overrides this extension's folder really holds (the bridge may be writing to a different copy). */
async function present(files) {
  const checks = await Promise.all(files.map((file) => fetch(chrome.runtime.getURL(overridePath(file)), { method: "HEAD", cache: "no-store" }).then((response) => response.ok, () => false)));
  return { found: files.filter((_, index) => checks[index]), missing: files.filter((_, index) => !checks[index]).map((file) => file.path) };
}

async function installRules(files) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  rulePaths = new Map(files.map((file, index) => [index + 1, file.path]));
  const addRules = files.map((file, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: "redirect", redirect: { extensionPath: overridePath(file) } },
    condition: {
      regexFilter: `^${escapeRegex(`${SITE}/${encodePath(file.path)}`)}(\\?.*)?$`,
      isUrlFilterCaseSensitive: true,
      initiatorDomains: [SITE_HOST],
      resourceTypes: RESOURCE_TYPES
    }
  }));
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: existing.map((rule) => rule.id), addRules });
}

/** Applies the bridge's latest state, then refreshes the dev tabs for whatever the tabs now load differently. */
async function applyState() {
  const { enabled, autoReload } = await settings();
  const wanted = bridge && enabled && !bridge.paused ? bridge.files : [];
  const { found: files, missing } = await present(wanted);
  if (bridge) send({ type: "missing", files: missing });
  await installRules(files);
  const { served = {} } = await chrome.storage.session.get("served");
  const next = Object.fromEntries(files.map((file) => [file.path, file.rev]));
  const changed = [...new Set([...Object.keys(served), ...Object.keys(next)])].filter((key) => served[key] !== next[key]);
  await chrome.storage.session.set({ served: next });
  await publish({
    connected: !!bridge, enabled, autoReload, paused: !!bridge?.paused, port: bridge?.port, root: bridge?.root, base: bridge?.base,
    files: bridge?.files || [], missing, live: bridge?.live || [], pending_deploy: bridge?.pending_deploy || [], stale: false
  });
  if (changed.length) await refreshTabs(changed, next, autoReload);
}

async function refreshTabs(changed, after, autoReload) {
  const tabs = await siteTabs();
  if (!tabs.length) return;
  // A stylesheet link re-requests its URL, which the rules now send to the new copy (or back to dev).
  const cssOnly = changed.every((rel) => rel.endsWith(".css"));
  for (const tab of tabs) {
    if (cssOnly) {
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: swapStylesheets, args: [changed.map((rel) => ({ path: `/${encodePath(rel)}`, rev: after[rel] || "dev" }))] }).catch(() => []);
      if (results.reduce((sum, entry) => sum + (Number(entry.result) || 0), 0) > 0) continue;
    }
    if (autoReload) await chrome.tabs.reload(tab.id).catch(() => {});
    else await publish({ stale: true });
  }
}

/** Runs in each frame: replaces the stylesheet links for the changed paths with fresh copies. */
function swapStylesheets(files) {
  let swapped = 0;
  for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
    let url;
    try { url = new URL(link.href, location.href); } catch { continue; }
    const file = url.origin === location.origin && files.find((entry) => entry.path === url.pathname);
    if (!file) continue;
    url.searchParams.set("fmb", file.rev);
    const fresh = link.cloneNode();
    fresh.href = url.href;
    fresh.addEventListener("load", () => link.remove(), { once: true });
    link.after(fresh);
    swapped++;
  }
  return swapped;
}

// ---------------------------------------------------------------------------------------------------------------
// Connection

async function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const { port } = await settings();
  // Probe first: a refused WebSocket fills the extension's error page every 30 seconds.
  const up = await fetch(`http://127.0.0.1:${port}/`, { cache: "no-store", signal: AbortSignal.timeout(1500) }).then((response) => response.ok, () => false);
  if (!up) { if (bridge || (await chrome.declarativeNetRequest.getSessionRules()).length) await disconnected(); else await publish({ connected: false }); return; }
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
  socket = ws;
  ws.onopen = async () => send({ type: "hello", protocol: PROTOCOL, version: chrome.runtime.getManifest().version, browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || "Chrome", tabs: await siteTabs() });
  ws.onmessage = (event) => { let message; try { message = JSON.parse(event.data); } catch { return; } handle(message).catch((error) => console.warn("FirstMate Dev Bridge:", error)); };
  ws.onclose = () => { if (socket === ws) { socket = null; disconnected(); } };
}

/** The bridge went away: dev's own files load again on the next reload. Pages are not reloaded. */
async function disconnected() {
  bridge = null;
  await installRules([]);
  await publish({ connected: false, files: [], missing: [], live: [], pending_deploy: [], stale: false });
}

async function handle(message) {
  if (message.type === "state") { bridge = message; await applyState(); return; }
  if (message.type === "ping") { send({ type: "pong", at: message.at }); return; }
  if (message.type === "bye") { const ws = socket; socket = null; ws?.close(); await disconnected(); return; }
  if (message.type === "command") {
    try { send({ type: "result", id: message.id, ok: true, value: await runCommand(message.name, message.args || {}) }); }
    catch (error) { send({ type: "result", id: message.id, ok: false, error: error?.message || String(error) }); }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Page commands

async function pickTab(id) {
  if (id !== undefined && id !== null) {
    const tab = await chrome.tabs.get(Number(id)).catch(() => null);
    if (!tab?.url?.startsWith(`${SITE}/`)) throw new Error(`Tab ${id} is not a ${SITE_HOST} tab.`);
    return tab;
  }
  const tabs = await chrome.tabs.query({ url: `${SITE}/*` });
  if (!tabs.length) throw new Error(`No ${SITE_HOST} tab is open in this Chrome.`);
  const focused = await chrome.windows.getLastFocused().catch(() => null);
  return tabs.find((tab) => tab.active && tab.windowId === focused?.id) || tabs.find((tab) => tab.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function frameTarget(tab, frame, allFrames) {
  if (!frame) return allFrames ? { tabId: tab.id, allFrames: true } : { tabId: tab.id, frameIds: [0] };
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) || [];
  const matches = frames.filter((entry) => entry.url.includes(frame));
  if (!matches.length) throw new Error(`No frame in tab ${tab.id} has "${frame}" in its address. Frames: ${frames.map((entry) => entry.url).join(", ")}`);
  return { tabId: tab.id, frameIds: allFrames ? matches.map((entry) => entry.frameId) : [matches[0].frameId] };
}

async function runCommand(name, args) {
  if (name === "tabs") return siteTabs();
  if (name === "reload") { const tab = await pickTab(args.tab); await chrome.tabs.reload(tab.id); return { reloaded: tab.id, url: tab.url }; }
  if (name === "navigate") {
    const url = new URL(String(args.url || "/"), SITE);
    if (url.origin !== SITE) throw new Error(`The bridge only navigates within ${SITE}.`);
    const tab = await pickTab(args.tab).catch(() => null);
    const result = tab ? await chrome.tabs.update(tab.id, { url: url.href }) : await chrome.tabs.create({ url: url.href });
    return { tab: result.id, url: url.href };
  }
  if (name === "eval") {
    const tab = await pickTab(args.tab);
    const results = await chrome.scripting.executeScript({ target: await frameTarget(tab, args.frame, args.allFrames), world: "MAIN", func: evaluateInPage, args: [String(args.code), Number(args.timeout || 30) * 1000] });
    const answers = results.map((entry) => ({ frameId: entry.frameId, ...(entry.result || { ok: false, error: "The frame returned nothing (it may have navigated)." }) }));
    if (answers.length === 1) { if (!answers[0].ok) throw new Error(answers[0].error); return answers[0].value; }
    return answers;
  }
  if (name === "console") {
    const tab = await pickTab(args.tab);
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", func: readConsole, args: [!!args.clear] });
    const order = { error: 0, warn: 1, info: 2, log: 3 };
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 50));
    return results.flatMap((entry) => entry.result || [])
      .filter((entry) => !args.level || order[entry.level] <= order[args.level])
      .sort((a, b) => a.t - b.t).slice(-limit);
  }
  if (name === "screenshot") {
    const tab = await pickTab(args.tab);
    if (!tab.active) { await chrome.tabs.update(tab.id, { active: true }); await sleep(400); }
    try { return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }), tab: tab.id, url: tab.url }; }
    catch (error) { throw new Error(`Chrome refused the screenshot (${error.message}). Open the extension's popup and choose "Allow screenshots", and keep the dev window un-minimised.`); }
  }
  throw new Error(`Unknown command "${name}".`);
}

/** Runs in the page (MAIN world). Expression first, then statements; awaits promises; returns JSON-safe data. */
async function evaluateInPage(code, timeoutMs) {
  const AsyncFunction = (async () => {}).constructor;
  const serialize = (value, depth = 0, seen = new WeakSet()) => {
    if (value === undefined) return depth ? null : "undefined";
    if (value === null || typeof value === "boolean" || typeof value === "number") return Number.isFinite(value) || typeof value !== "number" ? value : String(value);
    if (typeof value === "string") return value.length > 50000 ? `${value.slice(0, 50000)}… (${value.length} chars)` : value;
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (typeof value === "symbol") return String(value);
    if (value instanceof Error) return { error: value.name, message: value.message, stack: String(value.stack || "").split("\n").slice(0, 8).join("\n") };
    if (typeof Element !== "undefined" && value instanceof Element) {
      const html = value.outerHTML || "";
      return { element: `${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ""}${value.classList?.length ? `.${[...value.classList].join(".")}` : ""}`, text: (value.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300), html: html.length > 1500 ? `${html.slice(0, 1500)}…` : html };
    }
    if (typeof Node !== "undefined" && value instanceof Node) return `[${value.nodeName}]`;
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    if (depth >= 6) return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";
    seen.add(value);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Map) return { map: [...value.entries()].slice(0, 200).map(([key, entry]) => [serialize(key, depth + 1, seen), serialize(entry, depth + 1, seen)]) };
    if (value instanceof Set) return { set: [...value].slice(0, 200).map((entry) => serialize(entry, depth + 1, seen)) };
    if (Array.isArray(value) || (typeof NodeList !== "undefined" && value instanceof NodeList) || (typeof HTMLCollection !== "undefined" && value instanceof HTMLCollection)) {
      const items = Array.from(value);
      const out = items.slice(0, 300).map((entry) => serialize(entry, depth + 1, seen));
      if (items.length > 300) out.push(`… ${items.length - 300} more`);
      return out;
    }
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, 300)) { try { out[key] = serialize(value[key], depth + 1, seen); } catch (error) { out[key] = `[Throws ${error.message}]`; } }
    if (keys.length > 300) out["…"] = `${keys.length - 300} more keys`;
    return out;
  };
  try {
    let run;
    try { run = new AsyncFunction(`return (${code}\n)`); } catch { run = new AsyncFunction(code); }
    let timer;
    const value = await Promise.race([run.call(window), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms.`)), timeoutMs); })]);
    clearTimeout(timer);
    return { ok: true, value: serialize(value), url: location.href };
  } catch (error) {
    return { ok: false, error: `${error?.name || "Error"}: ${error?.message || error}${error?.stack ? `\n${String(error.stack).split("\n").slice(1, 6).join("\n")}` : ""}`, url: location.href };
  }
}

/** Runs in each frame (MAIN world): what page-console.js recorded there. */
function readConsole(clear) {
  const buffer = window.__fmBridgeConsole || [];
  const frame = window.top === window ? "top" : location.pathname + location.search.slice(0, 60);
  const entries = buffer.map((entry) => ({ ...entry, frame }));
  if (clear) buffer.length = 0;
  return entries;
}

// ---------------------------------------------------------------------------------------------------------------
// Events

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (message?.type === "fmb:getView") return (await chrome.storage.session.get("view")).view || { connected: false };
    if (message?.type === "fmb:reconnect") { socket?.close(); socket = null; await connect(); return true; }
    if (message?.type === "fmb:reloadTabs") { for (const tab of await siteTabs()) await chrome.tabs.reload(tab.id); await publish({ stale: false }); return true; }
    if (message?.type === "fmb:setEnabled") { await chrome.storage.local.set({ enabled: !!message.enabled }); return true; }
    return null;
  })().then(reply, (error) => reply({ error: error.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.port) { socket?.close(); socket = null; connect(); }
  else if (changes.enabled || changes.autoReload) applyState();
});

const tabsChanged = async () => send({ type: "tabs", tabs: await siteTabs() });
chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (change.status === "complete" && tab.url?.startsWith(`${SITE}/`)) tabsChanged(); });
chrome.tabs.onRemoved.addListener(() => tabsChanged());
chrome.tabs.onActivated.addListener(() => tabsChanged());

// Unpacked only (declarativeNetRequestFeedback): tells the bridge which overrides pages actually loaded.
chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
  const rel = rulePaths.get(info.rule.ruleId);
  if (rel && info.rule.rulesetId === chrome.declarativeNetRequest.SESSION_RULESET_ID) send({ type: "hit", path: rel, tab: info.request.tabId });
});

chrome.alarms.create("fmb-connect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "fmb-connect") connect(); });
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
connect();
