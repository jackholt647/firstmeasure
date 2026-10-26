// FirstMate Dev Bridge: records this frame's console messages and errors so `bridge.mjs console` can read them.
// Runs in the page's own world at document_start on dev.1m8.ai only. Keeps the last 500 entries in memory.
(() => {
  if (window.__fmBridgeConsole) return;
  const buffer = [];
  Object.defineProperty(window, "__fmBridgeConsole", { value: buffer, enumerable: false });
  const describe = (value, deep) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (value === null || typeof value !== "object") return String(value);
    if (typeof Element !== "undefined" && value instanceof Element) return `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ""}>`;
    if (!deep) return Array.isArray(value) ? `Array(${value.length})` : `{${Object.keys(value).slice(0, 8).join(", ")}}`;
    try { const text = JSON.stringify(value); return text && text.length > 2000 ? `${text.slice(0, 2000)}…` : String(text); } catch { return String(value); }
  };
  const push = (level, args) => {
    try {
      buffer.push({ t: Date.now(), level, text: Array.from(args, (value) => describe(value, level === "error" || level === "warn")).join(" ").slice(0, 4000) });
      if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
    } catch {}
  };
  for (const level of ["error", "warn", "info", "log"]) {
    const original = console[level];
    console[level] = function (...args) { push(level, args); return original.apply(this, args); };
  }
  addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) push("error", [`Failed to load ${target.tagName?.toLowerCase()} ${target.src || target.href}`]);
    else push("error", [event.error || `${event.message} (${event.filename}:${event.lineno})`]);
  }, true);
  addEventListener("unhandledrejection", (event) => push("error", ["Unhandled rejection:", event.reason]));
})();
