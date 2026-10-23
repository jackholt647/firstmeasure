import { createHash } from "node:crypto";

import { Codec, Model, type MutationChange, type ReplayEvent, type VirtualMirror, type VirtualNode } from "./library.js";

/**
 * Turns one recorded session into behaviour steps for search (docs/architecture/session-replay-search.md).
 * The recording is replayed into a virtual DOM on the server, so every click is resolved to the element a
 * person saw (its role, its name, where it sits) and to what it caused. Nothing here reads the original
 * application: identities come from the recorded page alone, so they work for any release of any app.
 */
export const INDEX_VERSION = 1;
const E = Codec.E, PTR = Codec.PTR;
const OUTCOME_WINDOW_MS = 1500;
const OUTCOME_RANK: Record<string, number> = { "": 0, none: 0, focus: 1, changed: 2, toggled: 3, dialog: 4, navigated: 5, error: 6 };
const RAGE_WINDOW_MS = 1000;
const IDLE_MS = 30000;
const BOOT_MS = 2500;
const MAX_SEARCH_CHARS = 40000;
const FIELD_ROLES = /^(textbox|combobox|checkbox|radio|switch|searchbox|spinbutton|slider)$/;
const ERROR_CLASS = /(^|[\s_-])(error|danger|invalid|alert|toast-error|is-error|has-error)([\s_-]|$)/i;

export type StepKind = "screen" | "click" | "input" | "key" | "dialog" | "ui_error" | "js_error" | "rage" | "idle" | "hidden" | "visible" | "custom" | "end";
export type IndexStep = {
  seq: number;
  page_id: string;
  t: number;
  kind: StepKind;
  screen_id: string;
  target_id: string;
  outcome: string;
  detail: Record<string, unknown>;
};
export type IndexedScreen = { screen_id: string; screen_key: string; label: string; url: string };
export type IndexedTarget = { target_id: string; role: string; label: string; path: string; screen_id: string };
export type SessionIndex = {
  steps: IndexStep[];
  screens: Map<string, IndexedScreen>;
  targets: Map<string, IndexedTarget>;
  searchText: string;
  counts: { clicks: number; js_errors: number; ui_errors: number; rage: number; dead: number; inputs: number; dialogs: number; screens: number };
  started_at: number;
  ended_at: number;
};
export type PageInput = { page_id: string; chunks: unknown[] };

const hashId = (prefix: string, key: string) => prefix + createHash("sha1").update(key).digest("hex").slice(0, 14);
const squash = (value: string) => String(value || "").replace(/\s+/g, " ").trim();
/** Numbers and generated ids vary between visits of the same thing; identity ignores them. */
export function normalizeLabel(value: string) {
  return squash(value).toLowerCase().replace(/\d+([.,:]\d+)*/g, "#").slice(0, 80);
}
export function normalizePath(value: string) {
  return String(value || "").replace(/[0-9a-f]{8,}(-[0-9a-f]{4,})*/gi, "#").replace(/\d{3,}/g, "#");
}
const ID_VALUE = /^(?:[a-z]+_[a-z0-9]{6,}(?:_[a-z0-9]+)*|[0-9a-f]{8,}(?:-[0-9a-f]{4,})*|.*\d{4,}.*|\d+)$/i;
const VOLATILE_PARAM = /^(utm_|fbclid|gclid|_|v$|t$|ts$|cache|nonce)/i;

/** A screen is a URL with its ids taken out: /portal/?tab=viewer&projectTab=materials&project=:id */
export function screenKey(url: string) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()].filter(([name]) => !VOLATILE_PARAM.test(name))
      .map(([name, value]) => [name, ID_VALUE.test(value) ? ":id" : value.toLowerCase().slice(0, 40)] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const pathName = u.pathname.split("/").map((part) => (ID_VALUE.test(part) ? ":id" : part)).join("/");
    const hash = u.hash.replace(/^#/, "").split(/[/?&=]/).filter(Boolean).map((part) => (ID_VALUE.test(part) ? ":id" : part)).join("/");
    return pathName + (params.length ? "?" + params.map(([n, v]) => n + "=" + v).join("&") : "") + (hash ? "#" + hash : "");
  } catch {
    return String(url || "").slice(0, 200);
  }
}

function screenLabel(key: string, title: string) {
  const cleanTitle = squash(title).replace(/^FirstMate\s*[-–|]\s*/i, "");
  const [pathPart, rest = ""] = key.split("?");
  const params = (rest.split("#")[0] || "").split("&").filter((p) => p && !p.endsWith("=:id")).map((p) => p.split("=")[1]).filter(Boolean);
  return [cleanTitle || pathPart, ...params].join(" · ").slice(0, 160);
}

function isDialog(v: VirtualNode) {
  const a = v.attrs;
  return !!a && (v.tag === "dialog" || a.role === "dialog" || a.role === "alertdialog" || a["aria-modal"] === "true");
}

const HIDDEN_CLASS = /(^|\s)(hidden|is-hidden|d-none|sr-only|visually-hidden|collapsed|is-closed|closed)(\s|$)/;
/** Hidden by markup alone (no stylesheets are evaluated): the hidden attribute, aria-hidden, inline display:none, hiding classes, a closed <dialog>. */
function isHidden(mirror: VirtualMirror, v: VirtualNode) {
  if (v.tag === "dialog" && v.attrs && v.attrs.open === undefined) return true;
  for (const n of [v, ...mirror.ancestors(v).slice(0, 8)]) {
    const a = n.attrs;
    if (!a) continue;
    if (a.hidden !== undefined || a["aria-hidden"] === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/.test(a.style || "") || HIDDEN_CLASS.test(a.class || "")) return true;
  }
  return false;
}

function isErrorElement(v: VirtualNode) {
  const a = v.attrs;
  if (!a) return false;
  return a.role === "alert" || a["aria-live"] === "assertive" || a["aria-invalid"] === "true" || ERROR_CLASS.test(a.class || "");
}

/** Indexes one session from its pages' parsed chunks (each page's chunks in sequence order). */
export function indexSession(pages: PageInput[]): SessionIndex {
  const steps: IndexStep[] = [];
  const screens = new Map<string, IndexedScreen>();
  const targets = new Map<string, IndexedTarget>();
  const search = new Set<string>();
  let searchChars = 0;
  const addText = (value: string) => {
    const text = squash(value);
    if (!text || text.length < 2 || searchChars > MAX_SEARCH_CHARS || search.has(text)) return;
    search.add(text);
    searchChars += text.length + 1;
  };
  const counts = { clicks: 0, js_errors: 0, ui_errors: 0, rage: 0, dead: 0, inputs: 0, dialogs: 0, screens: 0 };
  let started = Infinity, ended = 0;

  for (const input of pages) {
    const page = Model.readPage(input.chunks);
    if (!page.events.length) continue;
    const pageId = input.page_id;
    let screenId = "";
    let screenStep: IndexStep | null = null;
    let pendingClick: { step: IndexStep; until: number; role: string } | null = null;
    let recentClicks: Array<{ t: number; target: string }> = [];
    const fieldEdits = new Map<number, { step: IndexStep; before: string }>();
    let lastActivity = page.events[0]!.t;
    const lastUiError = new Map<string, number>();
    const lastDialog = new Map<string, number>();
    const openDialogs = new Set<number>();
    let bootUntil = 0;
    const push = (step: Omit<IndexStep, "seq" | "page_id">) => {
      const full = { ...step, seq: steps.length, page_id: pageId } as IndexStep;
      steps.push(full);
      return full;
    };
    const target = (mirror: VirtualMirror, node: VirtualNode | null) => {
      const v = mirror.interactive(node);
      if (!v) return { id: "", role: "", label: "" };
      const role = mirror.role(v);
      const label = squash(mirror.label(v)).slice(0, 120);
      const pathText = mirror.path(v);
      const id = hashId("t_", [role, normalizeLabel(label), normalizePath(pathText)].join("|"));
      if (!targets.has(id)) targets.set(id, { target_id: id, role, label, path: pathText, screen_id: screenId });
      return { id, role, label, node: v };
    };
    const enterScreen = (mirror: VirtualMirror, t: number, url: string) => {
      const key = screenKey(url);
      const id = hashId("s_", key);
      if (id === screenId) return;
      if (screenStep) screenStep.detail.ms = t - screenStep.t;
      screenId = id;
      if (!screens.has(id)) screens.set(id, { screen_id: id, screen_key: key, label: screenLabel(key, page.meta.title || ""), url });
      addText(screens.get(id)!.label);
      counts.screens++;
      screenStep = push({ t, kind: "screen", screen_id: id, target_id: "", outcome: "", detail: { url, title: page.meta.title || "", headings: mirror.headings(4) } });
    };
    // A click's outcome is the strongest thing that happened within its window.
    const noteOutcome = (outcome: string) => {
      if (!pendingClick) return;
      const step = pendingClick.step;
      if ((OUTCOME_RANK[outcome] ?? 0) > (OUTCOME_RANK[step.outcome] ?? 0)) step.outcome = outcome;
    };
    const closeClick = () => {
      if (!pendingClick) return;
      const click = pendingClick;
      pendingClick = null;
      if (!click.step.outcome) click.step.outcome = "none";
      if (click.step.outcome === "none" && !FIELD_ROLES.test(click.role)) { click.step.detail.dead = true; counts.dead++; }
    };
    const finishFields = () => {
      for (const [, edit] of fieldEdits) edit.step.detail.final_length = Number(edit.step.detail.final_length || 0);
      fieldEdits.clear();
    };

    page.walk({
      before(event: ReplayEvent) {
        if (pendingClick && event.t > pendingClick.until) closeClick();
        if (event.type !== E.DIAG && event.t - lastActivity >= IDLE_MS && screenId) {
          push({ t: lastActivity, kind: "idle", screen_id: screenId, target_id: "", outcome: "", detail: { ms: event.t - lastActivity } });
        }
        if (event.type !== E.DIAG) lastActivity = event.t;
        if (event.t < started) started = event.t;
        if (event.t > ended) ended = event.t;
      },
      after(event: ReplayEvent, mirror: VirtualMirror, change: MutationChange) {
        const a = event.a;
        switch (event.type) {
          case E.SNAPSHOT: {
            enterScreen(mirror, event.t, page.meta.url || mirror.url);
            for (const heading of mirror.headings(8)) addText(heading);
            if (mirror.root) addText(mirror.textOf(mirror.root, 6000));
            bootUntil = event.t + BOOT_MS;
            openDialogs.clear();
            for (const v of mirror.nodes.values()) if (isDialog(v) && !isHidden(mirror, v)) openDialogs.add(v.id);
            break;
          }
          case E.NAV: {
            noteOutcome("navigated");
            enterScreen(mirror, event.t, mirror.url);
            break;
          }
          case E.MUT: {
            if (!change) break;
            // A dialog counts when it becomes visible after the page has loaded; panels the app
            // renders hidden while it boots, or keeps re-rendering while open, do not.
            const booting = event.t < bootUntil;
            const dialogs: string[] = [];
            const messages: string[] = [];
            const candidates: VirtualNode[] = [];
            const scan = (v: VirtualNode, depth: number) => {
              if (depth > 40 || !v.attrs) return;
              if (isDialog(v)) candidates.push(v);
              if (isErrorElement(v)) { if (!booting && !isHidden(mirror, v)) { const m = squash(mirror.textOf(v, 200)); if (m) messages.push(m); } return; }
              if (v.children) for (const child of v.children) scan(child, depth + 1);
            };
            for (const v of change.removed) if (openDialogs.has(v.id)) openDialogs.delete(v.id);
            for (const v of change.added) { scan(v, 0); addText(mirror.textOf(v, 1500)); }
            for (const v of change.texts) {
              for (const n of [v, ...mirror.ancestors(v).slice(0, 3)]) if (isErrorElement(n)) { if (!booting && !isHidden(mirror, n)) { const m = squash(mirror.textOf(n, 200)); if (m) messages.push(m); } break; }
              addText(v.text);
            }
            for (const [v, name] of change.attrs) if (/^(open|hidden|aria-hidden|class|style)$/.test(name) && isDialog(v)) candidates.push(v);
            for (const v of candidates) {
              const visible = !isHidden(mirror, v);
              if (!visible) { openDialogs.delete(v.id); continue; }
              const title = squash(mirror.headingIn(v) || mirror.label(v)).slice(0, 120);
              const key = normalizeLabel(title);
              if (openDialogs.has(v.id)) continue;
              openDialogs.add(v.id);
              if (booting || (lastDialog.get(key) ?? -Infinity) > event.t - 2000) continue;
              lastDialog.set(key, event.t);
              dialogs.push(title);
            }
            for (const title of new Set(dialogs)) {
              counts.dialogs++;
              addText(title);
              push({ t: event.t, kind: "dialog", screen_id: screenId, target_id: "", outcome: "", detail: { title } });
            }
            for (const message of new Set(messages)) {
              const key = normalizeLabel(message);
              if ((lastUiError.get(key) ?? -Infinity) > event.t - 5000) continue;
              lastUiError.set(key, event.t);
              counts.ui_errors++;
              addText(message);
              push({ t: event.t, kind: "ui_error", screen_id: screenId, target_id: "", outcome: "", detail: { message, key } });
            }
            if (pendingClick) {
              if (dialogs.length) noteOutcome("dialog");
              if (messages.length) noteOutcome("error");
              if (change.added.length || change.removed.length || change.texts.length || change.attrs.length) noteOutcome("changed");
            }
            break;
          }
          case E.PTR: {
            const kind = a[0];
            if (kind !== PTR.CLICK && kind !== PTR.CONTEXTMENU && kind !== PTR.DBLCLICK) break;
            closeClick();
            const hit = target(mirror, mirror.node(a[1]));
            counts.clicks++;
            const context = hit.node ? mirror.context(hit.node, 3) : [];
            const step = push({
              t: event.t, kind: "click", screen_id: screenId, target_id: hit.id, outcome: "",
              detail: { label: hit.label, role: hit.role, x: a[2], y: a[3], button: a[4], pointer: a[5] === 1 ? "touch" : a[5] === 2 ? "pen" : "mouse",
                ...(kind === PTR.CONTEXTMENU ? { context_menu: true } : {}), ...(kind === PTR.DBLCLICK ? { double: true } : {}), ...(context.length ? { context } : {}) }
            });
            addText(hit.label);
            if (FIELD_ROLES.test(hit.role)) step.outcome = "focus";
            pendingClick = { step, until: event.t + OUTCOME_WINDOW_MS, role: hit.role };
            recentClicks = recentClicks.filter((c) => event.t - c.t <= RAGE_WINDOW_MS && c.target === hit.id);
            recentClicks.push({ t: event.t, target: hit.id });
            if (recentClicks.length === 3) {
              counts.rage++;
              push({ t: event.t, kind: "rage", screen_id: screenId, target_id: hit.id, outcome: "", detail: { label: hit.label, clicks: 3 } });
            } else if (recentClicks.length > 3) {
              const rage = [...steps].reverse().find((s) => s.kind === "rage" && s.target_id === hit.id);
              if (rage) rage.detail.clicks = recentClicks.length;
            }
            break;
          }
          case E.INPUT: {
            noteOutcome("toggled");
            const node = mirror.node(a[0]);
            const field = target(mirror, node);
            let edit = fieldEdits.get(a[0]);
            if (!edit) {
              counts.inputs++;
              const masked = !!node && /^\*+$/.test(mirror.values.get(a[0]) || "") && (mirror.values.get(a[0]) || "").length > 0;
              edit = { before: "", step: push({ t: event.t, kind: "input", screen_id: screenId, target_id: field.id, outcome: "", detail: { label: field.label, role: field.role, changes: 0, deleted: 0, masked } }) };
              fieldEdits.set(a[0], edit);
              addText(field.label);
            }
            const detail = edit.step.detail as Record<string, number | boolean | string>;
            detail.changes = Number(detail.changes) + 1;
            if (a[1] === 2) detail.deleted = Number(detail.deleted) + Number(a[3] || 0);
            if (a[1] === 1) detail.checked = !!a[2];
            const value = mirror.values.get(a[0]) || "";
            detail.final_length = value.length;
            detail.ms = event.t - edit.step.t;
            break;
          }
          case E.FOCUS: {
            noteOutcome("focus");
            if (fieldEdits.size && !fieldEdits.has(a[0])) finishFields();
            break;
          }
          case E.KEY: {
            const key = page.text(a[0]);
            if (key === "char" || /^(Shift|Control|Alt|Meta|CapsLock)$/.test(key)) break;
            const focused = mirror.node(mirror.focusId) || mirror.node(a[2]);
            const field = target(mirror, focused);
            const mods = Number(a[1] || 0);
            const name = [(mods & 1) ? "Ctrl" : "", (mods & 2) ? "Alt" : "", (mods & 8) ? "Cmd" : "", (mods & 4) && key.length > 1 ? "Shift" : "", key.length === 1 ? key.toUpperCase() : key].filter(Boolean).join("+");
            push({ t: event.t, kind: "key", screen_id: screenId, target_id: field.id, outcome: "", detail: { key: name, label: field.label } });
            break;
          }
          case E.ERR: {
            const message = squash(page.text(a[0])).slice(0, 300);
            counts.js_errors++;
            push({ t: event.t, kind: "js_error", screen_id: screenId, target_id: "", outcome: "", detail: { message, key: normalizeLabel(message), source: page.text(a[1]).slice(0, 200), line: a[2] } });
            break;
          }
          case E.VIS: push({ t: event.t, kind: a[0] ? "hidden" : "visible", screen_id: screenId, target_id: "", outcome: "", detail: {} }); break;
          case E.CUSTOM: push({ t: event.t, kind: "custom", screen_id: screenId, target_id: "", outcome: "", detail: { name: page.text(a[0]), data: page.text(a[1]).slice(0, 500) } }); break;
          case E.END: push({ t: event.t, kind: "end", screen_id: screenId, target_id: "", outcome: "", detail: {} }); break;
          default: break;
        }
      }
    });
    closeClick();
    finishFields();
    const pageEnd = Math.max(page.events[page.events.length - 1]!.t, page.cursor.length ? page.cursor[page.cursor.length - 3]! : 0);
    if (screenStep) (screenStep as IndexStep).detail.ms = pageEnd - (screenStep as IndexStep).t;
    if (pageEnd > ended) ended = pageEnd;
  }
  steps.sort((x, y) => x.t - y.t || x.seq - y.seq);
  steps.forEach((step, index) => { step.seq = index; });
  return { steps, screens, targets, searchText: [...search].join("\n"), counts, started_at: isFinite(started) ? started : 0, ended_at: ended };
}
