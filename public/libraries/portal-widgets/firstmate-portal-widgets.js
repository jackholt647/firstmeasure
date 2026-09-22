/**
 * FirstMate portal widgets — customer-portal widget pack for the document
 * engine (global FirstMatePortalWidgets).
 *
 * Registers `portal.*` widgets into the SAME FMDocWidgets registry that
 * doc-widgets and web-widgets fill (load AFTER doc-widgets; the registry is
 * shared so the renderer/editor need no special casing). Contract:
 * docs/document-engine-contracts.md §2 (widget shape/ctx) and §11 (portal.*),
 * docs/customer-portal-v2-spec.md §6.
 *
 * Widgets (read-only set):
 *   portal.activity_feed  — customer-visible project timeline
 *   portal.reviews        — the org's own feedback ratings + review destinations
 *   portal.team           — people assigned to this project
 *   portal.portfolio      — before/after media pairs
 *   portal.welcome_video  — a titled video card (thin wrapper over media)
 *   portal.recurring      — recurring visit schedule
 *
 * EVERY widget here renders from `ctx.data` produced by a server resolver. When
 * `ctx.data` is null — which is what happens when the widget is dropped on a
 * public marketing page, or previewed in the editor — it renders a labeled
 * placeholder instead. That is the mechanism that keeps project data from
 * leaking onto non-portal surfaces: the client half literally has nothing to
 * show without the server half having decided it was allowed.
 *
 * CSS is embedded and self-injected (<style id="fm-portal-widgets-styles">) per
 * the library CSS rule — no standalone stylesheet is ever fetched.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FirstMatePortalWidgets = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null, function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function widgetsLib() {
    if (root && root.FMDocWidgets) return root.FMDocWidgets;
    if (typeof require === "function") {
      try {
        return require("../doc-widgets/firstmate-doc-widgets.js");
      } catch (error) {
        /* registry unavailable (headless without doc-widgets) */
      }
    }
    return null;
  }

  function cleanText(value) {
    return String(value === null || value === undefined ? "" : value).trim();
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  }

  function icon(name) {
    const node = document.createElement("i");
    node.className = "fa-solid " + cleanText(name || "fa-circle");
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  /** Labeled placeholder — the universal "no server data" render. */
  function placeholder(el, title, hint) {
    el.innerHTML = "";
    const box = h("div", "fmpw-placeholder");
    box.appendChild(icon("fa-puzzle-piece"));
    box.appendChild(h("strong", null, title));
    if (hint) box.appendChild(h("span", null, hint));
    el.appendChild(box);
  }

  function sectionHead(el, title, subtitle) {
    if (!cleanText(title)) return;
    const head = h("div", "fmpw-head");
    head.appendChild(h("h3", null, cleanText(title)));
    if (cleanText(subtitle)) head.appendChild(h("p", null, cleanText(subtitle)));
    el.appendChild(head);
  }

  function formatDate(value) {
    const raw = cleanText(value);
    if (!raw) return "";
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function starRow(rating) {
    const value = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    const wrap = h("span", "fmpw-stars");
    wrap.setAttribute("aria-label", value + " out of 5");
    for (let index = 0; index < 5; index += 1) {
      const star = h("i", index < value ? "fa-solid fa-star" : "fa-regular fa-star");
      star.setAttribute("aria-hidden", "true");
      wrap.appendChild(star);
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const STYLES = `
.fmpw-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  min-height:96px;padding:18px;border:1px dashed #d3d8e0;border-radius:12px;background:#fbfcfd;color:#69707d;
  font-size:12px;text-align:center}
.fmpw-placeholder i{font-size:16px;color:#9aa2b1}
.fmpw-placeholder strong{font-size:13px;font-weight:800;color:#3c4350}
.fmpw-head{margin:0 0 12px}
.fmpw-head h3{margin:0;font-size:15px;font-weight:800;letter-spacing:-0.01em;color:#101828}
.fmpw-head p{margin:3px 0 0;font-size:12px;color:#69707d}
.fmpw-empty{padding:16px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;color:#69707d;font-size:12px}

.fmpw-feed{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0}
.fmpw-feed li{position:relative;display:flex;gap:12px;padding:0 0 16px 0}
.fmpw-feed li:last-child{padding-bottom:0}
.fmpw-feed .fmpw-rail{position:relative;display:flex;flex-direction:column;align-items:center;width:26px;flex:0 0 26px}
.fmpw-feed .fmpw-dot{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:var(--fm-primary,#2563EB);color:#fff;font-size:11px;flex:0 0 26px}
.fmpw-feed li:not(:last-child) .fmpw-rail:after{content:"";position:absolute;top:26px;bottom:-16px;width:2px;background:#e4e7ec}
.fmpw-feed .fmpw-body{padding-top:3px}
.fmpw-feed .fmpw-body strong{display:block;font-size:13px;font-weight:700;color:#101828}
.fmpw-feed .fmpw-body span{display:block;font-size:11px;color:#69707d;margin-top:2px}
.fmpw-feed .fmpw-body p{margin:4px 0 0;font-size:12px;line-height:1.45;color:#667085}
.fmpw-feed.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.fmpw-feed.cards li{padding:14px;border:1px solid #e4e7ec;border-radius:12px;background:#fff}
.fmpw-feed.cards li .fmpw-rail:after{display:none}
.fmpw-feed.compact li{padding-bottom:9px}.fmpw-feed.compact .fmpw-dot{width:20px;height:20px;flex-basis:20px;font-size:9px}

.fmpw-reviews{display:flex;flex-direction:column;gap:12px}
.fmpw-review-summary{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid #e4e7ec;border-radius:12px;background:#fff}
.fmpw-review-summary .fmpw-score{font-size:28px;font-weight:800;line-height:1;color:#101828}
.fmpw-stars{display:inline-flex;gap:2px;color:#f5a623;font-size:12px}
.fmpw-review-summary small{display:block;font-size:11px;color:#69707d;margin-top:3px}
.fmpw-review-list{display:flex;flex-direction:column;gap:10px}
.fmpw-review{padding:12px 14px;border:1px solid #e4e7ec;border-radius:12px;background:#fff}
.fmpw-review p{margin:6px 0 0;font-size:12px;line-height:1.5;color:#3c4350}
.fmpw-review .fmpw-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:#69707d}
.fmpw-review-cta{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;padding:9px 14px;border-radius:9px;
  background:var(--fm-primary,#2563EB);color:#fff;font-size:12px;font-weight:700;text-decoration:none}

.fmpw-team{display:grid;grid-template-columns:repeat(var(--fmpw-columns,3),minmax(0,1fr));gap:12px}
.fmpw-member{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #e4e7ec;border-radius:12px;background:#fff}
.fmpw-team.cards .fmpw-member{display:block;text-align:center;padding:18px 14px}
.fmpw-avatar{width:38px;height:38px;border-radius:50%;object-fit:cover;flex:0 0 38px;background:#eef1f5;
  display:flex;align-items:center;justify-content:center;color:#69707d;font-weight:800;font-size:13px}
.fmpw-team.cards .fmpw-avatar{width:72px;height:72px;margin:0 auto 10px;flex-basis:72px;font-size:22px}
.fmpw-team.square .fmpw-avatar{border-radius:12px}
.fmpw-member strong{display:block;font-size:12px;font-weight:800;color:#101828}
.fmpw-member span{display:block;font-size:11px;color:#69707d;text-transform:uppercase;letter-spacing:.04em}
.fmpw-member p{margin:7px 0 0;font-size:11px;line-height:1.45;color:#667085}

.fmpw-portfolio{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.fmpw-pair{border:1px solid #e4e7ec;border-radius:12px;overflow:hidden;background:#fff}
.fmpw-pair-imgs{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#e4e7ec}
.fmpw-pair-imgs figure{margin:0;position:relative;background:#f4f6f8}
.fmpw-pair-imgs img{display:block;width:100%;height:120px;object-fit:cover}
.fmpw-pair-imgs figcaption{position:absolute;left:6px;top:6px;padding:2px 7px;border-radius:20px;background:rgba(16,24,40,.72);
  color:#fff;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
.fmpw-pair-label{padding:9px 11px;font-size:12px;font-weight:700;color:#101828}
.fmpw-pair-caption{padding:0 11px 11px;font-size:11px;line-height:1.45;color:#667085}
.fmpw-portfolio.stack{grid-template-columns:1fr}
.fmpw-portfolio.slider{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.fmpw-compare{position:relative;aspect-ratio:16/10;overflow:hidden;background:#eef1f5}
.fmpw-compare img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.fmpw-compare .after{clip-path:inset(0 50% 0 0)}
.fmpw-compare-range{position:absolute;left:10px;right:10px;bottom:10px;width:calc(100% - 20px);accent-color:var(--fm-primary,#2563EB)}

.fmpw-video{border:1px solid #e4e7ec;border-radius:12px;overflow:hidden;background:#000}
.fmpw-video video{display:block;width:100%;height:auto}
.fmpw-video-placeholder{display:grid;place-items:center;min-height:220px;padding:24px;text-align:center;
  background:linear-gradient(145deg,#172033,#344054);color:#fff}
.fmpw-video-placeholder i{display:grid;place-items:center;width:58px;height:58px;margin:0 auto 12px;border-radius:50%;
  background:rgba(255,255,255,.16);font-size:23px}.fmpw-video-placeholder strong{display:block;font-size:15px}
.fmpw-video-placeholder span{display:block;margin-top:5px;font-size:11px;color:rgba(255,255,255,.7)}
.fmpw-video-caption{padding:10px 12px;background:#fff;font-size:12px;color:#3c4350}

.fmpw-nearby-map{position:relative;min-height:220px;border:1px solid #e4e7ec;border-radius:14px;overflow:hidden;background:#eaf0eb}
.fmpw-nearby-map>img{display:block;width:100%;height:100%;min-height:220px;object-fit:cover}
.fmpw-map-plot{position:absolute;inset:0;background:linear-gradient(30deg,transparent 48%,rgba(255,255,255,.7) 49%,rgba(255,255,255,.7) 51%,transparent 52%),linear-gradient(-30deg,transparent 48%,rgba(255,255,255,.55) 49%,rgba(255,255,255,.55) 51%,transparent 52%);background-size:80px 80px}
.fmpw-map-pin{position:absolute;transform:translate(-50%,-100%);width:24px;height:24px;border-radius:50% 50% 50% 0;rotate:-45deg;background:#ef4444;box-shadow:0 3px 8px rgba(15,23,42,.25)}
.fmpw-map-pin:after{content:"";position:absolute;width:8px;height:8px;border-radius:50%;background:#fff;left:8px;top:8px}
.fmpw-map-pin.you{background:var(--fm-primary,#2563EB)}
.fmpw-nearby-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:12px}
.fmpw-nearby-job{display:grid;grid-template-columns:64px 1fr;gap:10px;align-items:center;padding:9px;border:1px solid #e4e7ec;border-radius:12px;background:#fff}
.fmpw-nearby-job.no-photo{grid-template-columns:1fr}.fmpw-nearby-job img{width:64px;height:58px;border-radius:8px;object-fit:cover}
.fmpw-nearby-job strong{display:block;font-size:12px;color:#101828}.fmpw-nearby-job span{display:block;margin-top:2px;font-size:10px;color:#667085}
.fmpw-privacy{margin:9px 2px 0;font-size:10px;color:#858d9a}
@media(max-width:600px){.fmpw-team{grid-template-columns:repeat(min(2,var(--fmpw-columns,2)),minmax(0,1fr))}.fmpw-nearby-list{grid-template-columns:1fr}}

.fmpw-recurring{display:flex;flex-direction:column;gap:10px}
.fmpw-head-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.fmpw-progress{font-size:12px;font-weight:800;color:#69707d}
.fmpw-link{margin-top:10px;border:0;background:none;padding:0;color:var(--fm-primary,#2563EB);
  font:inherit;font-size:12px;font-weight:800;cursor:pointer;text-decoration:underline}
.fmpw-project-header{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px;
  padding:18px 20px;border:1px solid #e4e7ec;border-radius:14px;background:#fff}
.fmpw-project-header h2{margin:0;font-size:20px;font-weight:800;letter-spacing:-0.01em;color:#101828}
.fmpw-project-header p{margin:4px 0 0;font-size:13px;color:#69707d}
.fmpw-contact{margin:0;display:grid;grid-template-columns:auto auto;gap:2px 12px;align-content:start}
.fmpw-contact dt{font-size:10px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:#9aa2b1}
.fmpw-contact dd{margin:0;font-size:12px;font-weight:700;color:#3c4350;text-align:right}
.fmpw-steps{display:grid;gap:8px}
.fmpw-step{display:flex;align-items:flex-start;gap:11px;width:100%;text-align:left;padding:12px 14px;
  border:1px solid #e4e7ec;border-radius:12px;background:#fff;font:inherit;color:inherit;cursor:pointer}
.fmpw-step:disabled{cursor:default;opacity:.65}
.fmpw-step.current{border-color:rgba(37,99,235,.5);box-shadow:0 0 0 3px rgba(37,99,235,.08)}
.fmpw-step.done .fmpw-step-dot{color:#12844a}
.fmpw-step-dot{color:#c3c9d4;font-size:15px;line-height:1.3}
.fmpw-step-copy{display:grid;gap:2px;min-width:0}
.fmpw-step-copy strong{font-size:13px;font-weight:800;color:#101828}
.fmpw-step-copy small{font-size:12px;color:#69707d}
.fmpw-visits{display:grid;gap:8px}
.fmpw-visit{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #e4e7ec;border-radius:12px;background:#fff}
.fmpw-visit strong{display:block;font-size:13px;font-weight:800;color:#101828}
.fmpw-visit span{display:block;font-size:12px;color:#69707d;margin-top:2px}
.fmpw-visit .fmpw-dot{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;
  background:rgba(37,99,235,.1);color:var(--fm-primary,#2563EB);flex:0 0 32px}
.fmpw-strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px}
.fmpw-strip-tile{border-radius:10px;overflow:hidden;background:#f4f6f8;aspect-ratio:4/3}
.fmpw-strip-tile img{display:block;width:100%;height:100%;object-fit:cover}
.fmpw-series{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #e4e7ec;border-radius:12px;background:#fff}
.fmpw-series .fmpw-dot{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;
  background:rgba(37,99,235,.1);color:var(--fm-primary,#2563EB);flex:0 0 32px}
.fmpw-series strong{display:block;font-size:13px;font-weight:800;color:#101828}
.fmpw-series span{display:block;font-size:11px;color:#69707d;margin-top:2px}
`;

  function ensureStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById("fm-portal-widgets-styles")) return;
    const style = document.createElement("style");
    style.id = "fm-portal-widgets-styles";
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Renderers
  // ---------------------------------------------------------------------------

  function previewImage(label, start, end) {
    const safe = cleanText(label).replace(/[<>&]/g, "");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs><rect width="720" height="420" fill="url(#g)"/><path d="M150 250 360 100l210 150v120H150z" fill="rgba(255,255,255,.84)"/><path d="M115 250 360 72l245 178" fill="none" stroke="rgba(16,24,40,.42)" stroke-width="28" stroke-linejoin="round"/><rect x="315" y="255" width="90" height="115" rx="4" fill="rgba(16,24,40,.28)"/><text x="36" y="54" fill="white" font-family="Arial,sans-serif" font-size="24" font-weight="700">${safe}</text></svg>`;
    return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
  }

  function optionLabel(definition, listKey, itemKey, value) {
    const field = asArray(definition && definition.configPanel).find((entry) => entry && entry.key === listKey);
    const itemField = asArray(field && field.itemFields).find((entry) => entry && entry.key === itemKey);
    const option = asArray(itemField && itemField.options).find((entry) => {
      if (Array.isArray(entry)) return String(entry[0]) === String(value);
      return entry && String(entry.value) === String(value);
    });
    if (Array.isArray(option)) return cleanText(option[1]) || cleanText(option[0]);
    return cleanText(option && (option.label || option.value));
  }

  function renderActivityFeed(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    let data = ctx && ctx.data;
    const config = (ctx && ctx.config) || {};
    if (!data && ctx && ctx.preview === true) {
      const manual = ["manual", "hybrid"].includes(cleanText(config.source_mode))
        ? asArray(config.manual_entries).map((entry) => ({ label: entry.label, detail: entry.detail, at: entry.date, icon: entry.icon }))
        : [];
      data = { entries: manual.length ? manual : [
        { label: (globalThis.PlatformLanguage?.text("portal-widgets","m_8a61d5ab2b73c6","Materials delivered") ?? "Materials delivered"), detail: "Everything is on site and ready for the crew.", at: "2026-08-01", icon: "fa-truck" },
        { label: (globalThis.PlatformLanguage?.text("portal-widgets","m_6777e88c5f5f55","Installation underway") ?? "Installation underway"), detail: "The team completed the first major project milestone.", at: "2026-07-30", icon: "fa-hammer" },
        { label: (globalThis.PlatformLanguage?.text("portal-widgets","m_0d864599471c83","Project kickoff") ?? "Project kickoff"), detail: "Work started and your project team is assigned.", at: "2026-07-28", icon: "fa-circle-check" }
      ] };
    }
    const entries = asArray(data && data.entries);
    if (!data) {
      placeholder(el, "Project updates", "Shows this project's timeline in the customer portal.");
      return;
    }
    sectionHead(el, cleanText(config.title) || "Project updates", cleanText(config.subtitle));
    if (!entries.length) {
      el.appendChild(h("div", "fmpw-empty", "No updates to show yet."));
      return;
    }
    const style = ["timeline", "cards", "compact"].includes(cleanText(config.layout)) ? cleanText(config.layout) : "timeline";
    const list = h("ul", "fmpw-feed " + style);
    for (const entry of entries) {
      const item = h("li");
      const rail = h("div", "fmpw-rail");
      const dot = h("div", "fmpw-dot");
      dot.appendChild(icon(cleanText(entry.icon) || "fa-circle-check"));
      rail.appendChild(dot);
      const body = h("div", "fmpw-body");
      // `label` is server-composed from an allowlisted payload subset — the raw
      // event payload is never rendered here (spec §7).
      body.appendChild(h("strong", null, cleanText(entry.label)));
      const when = formatDate(entry.at);
      if (when && config.show_dates !== false) body.appendChild(h("span", null, when));
      if (cleanText(entry.detail) && config.show_details !== false) body.appendChild(h("p", null, cleanText(entry.detail)));
      item.appendChild(rail);
      item.appendChild(body);
      list.appendChild(item);
    }
    el.appendChild(list);
  }

  function renderReviews(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    const data = ctx && ctx.data;
    const config = (ctx && ctx.config) || {};
    // A disabled server response must remove the surface entirely. Returning a
    // normal null placeholder would still expose an unfinished Reviews card on
    // older published portal pages that already contain this widget.
    if (data && data.disabled === true) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (!data) {
      placeholder(el, "Reviews", "Shows your rating summary and recent customer feedback.");
      return;
    }
    sectionHead(el, cleanText(config.title) || "What customers say", cleanText(config.subtitle));
    const wrap = h("div", "fmpw-reviews");

    const average = Number(data.average_rating) || 0;
    const count = Number(data.rating_count) || 0;
    if (count > 0 && config.show_summary !== false) {
      const summary = h("div", "fmpw-review-summary");
      summary.appendChild(h("div", "fmpw-score", average.toFixed(1)));
      const meta = h("div");
      meta.appendChild(starRow(average));
      meta.appendChild(h("small", null, "Based on " + count + " review" + (count === 1 ? "" : "s")));
      summary.appendChild(meta);
      wrap.appendChild(summary);
    }

    const reviews = asArray(data.reviews);
    if (reviews.length) {
      const list = h("div", "fmpw-review-list");
      for (const review of reviews) {
        const card = h("div", "fmpw-review");
        const meta = h("div", "fmpw-meta");
        meta.appendChild(starRow(review.rating));
        const author = cleanText(review.author);
        if (author) meta.appendChild(h("span", null, author));
        const when = formatDate(review.at);
        if (when) meta.appendChild(h("span", null, when));
        card.appendChild(meta);
        const comment = cleanText(review.comment);
        if (comment) card.appendChild(h("p", null, comment));
        list.appendChild(card);
      }
      wrap.appendChild(list);
    } else if (count === 0) {
      wrap.appendChild(h("div", "fmpw-empty", "No reviews yet."));
    }

    const destination = (asArray(data.destinations)[0]) || null;
    if (destination && cleanText(destination.url)) {
      const cta = document.createElement("a");
      cta.className = "fmpw-review-cta";
      cta.href = cleanText(destination.url);
      cta.target = "_blank";
      cta.rel = "noopener noreferrer";
      cta.appendChild(icon("fa-star"));
      cta.appendChild(h("span", null, cleanText(destination.label) || "Leave a review"));
      wrap.appendChild(cta);
    }
    el.appendChild(wrap);
  }

  function renderTeam(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    const data = ctx && ctx.data;
    const config = (ctx && ctx.config) || {};
    sectionHead(el, cleanText(config.title) || "Meet your team", cleanText(config.subtitle));
    let members = asArray(data && data.members);
    const sourceMode = cleanText(config.source_mode) || "automatic";
    const manualMembers = ["manual", "hybrid"].includes(sourceMode) ? asArray(config.manual_members).map((member) => ({
      name: cleanText(member.name) || "Team member",
      role: cleanText(member.role),
      bio: cleanText(member.bio),
      avatar_url: ctx && typeof ctx.mediaUrl === "function" ? cleanText(ctx.mediaUrl(member.photo, "thumb")) : ""
    })) : [];
    if (!members.length && ctx && ctx.preview === true) {
      const selectedMembers = ["automatic", "hybrid"].includes(sourceMode) ? asArray(config.selected_user_ids).map((entry) => {
        const userId = cleanText(entry && typeof entry === "object" ? entry.user_id : entry);
        if (!userId) return null;
        return { name: optionLabel(ctx.definition, "selected_user_ids", "user_id", userId) || "Selected team member", role: "Project team" };
      }).filter(Boolean) : [];
      members = selectedMembers.concat(manualMembers);
      // A newly inserted automatic widget has no project resolver response yet.
      // Representative people make the complete on-canvas design visible; as
      // soon as users are selected or project data arrives, those exact people
      // replace these samples in the same widget.
      if (!members.length) members = [
        { name: "Alex Morgan", role: "Project Manager", bio: "Your main point of contact." },
        { name: "Jordan Lee", role: "Site Lead", bio: "Coordinates work on site." },
        { name: "Sam Rivera", role: "Customer Care", bio: "Here when you need help." }
      ];
    } else if (!members.length) {
      members = manualMembers;
    }
    if (!members.length) {
      el.appendChild(h("div", "fmpw-empty", "Your team will appear here once they are assigned."));
      return;
    }
    const layout = cleanText(config.layout) === "list" ? "list" : "cards";
    const shape = cleanText(config.photo_shape) === "square" ? "square" : "round";
    const grid = h("div", `fmpw-team ${layout} ${shape}`);
    const configuredColumns = Math.max(1, Math.min(4, Number(config.columns) || 3));
    grid.style.setProperty("--fmpw-columns", String(configuredColumns));
    for (const member of members) {
      const card = h("div", "fmpw-member");
      const avatarUrl = cleanText(member.avatar_url);
      if (avatarUrl) {
        const img = document.createElement("img");
        img.className = "fmpw-avatar";
        img.src = avatarUrl;
        img.alt = "";
        card.appendChild(img);
      } else {
        card.appendChild(h("div", "fmpw-avatar", cleanText(member.name).slice(0, 1).toUpperCase() || "?"));
      }
      const body = h("div");
      body.appendChild(h("strong", null, cleanText(member.name)));
      const role = config.show_role === false ? "" : cleanText(member.role);
      if (role) body.appendChild(h("span", null, role));
      const bio = config.show_bio === true ? cleanText(member.bio) : "";
      if (bio) body.appendChild(h("p", null, bio));
      card.appendChild(body);
      grid.appendChild(card);
    }
    el.appendChild(grid);
  }

  function renderPortfolio(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    let data = ctx && ctx.data;
    const config = (ctx && ctx.config) || {};
    if (!data && ctx && ctx.preview === true) {
      const manual = ["manual", "hybrid"].includes(cleanText(config.source_mode)) ? asArray(config.manual_pairs).map((pair) => ({
        label: cleanText(pair.label),
        caption: cleanText(pair.caption),
        before_url: ctx && typeof ctx.mediaUrl === "function" ? cleanText(ctx.mediaUrl(pair.before, "preview")) : "",
        after_url: ctx && typeof ctx.mediaUrl === "function" ? cleanText(ctx.mediaUrl(pair.after, "preview")) : ""
      })).filter((pair) => pair.before_url || pair.after_url) : [];
      data = { pairs: manual.length ? manual : [{
        label: (globalThis.PlatformLanguage?.text("portal-widgets","m_41927986ef26c5","Exterior transformation") ?? "Exterior transformation"),
        caption: (globalThis.PlatformLanguage?.text("portal-widgets","m_e1bc472e6ee337","A representative before-and-after pair. Add project photos to replace it.") ?? "A representative before-and-after pair. Add project photos to replace it."),
        before_url: previewImage("Before", "#667085", "#344054"),
        after_url: previewImage("After", "#2563eb", "#123b74")
      }] };
    }
    if (!data) {
      placeholder(el, "Before & after", "Shows before/after photo pairs from this project.");
      return;
    }
    sectionHead(el, cleanText(config.title) || "Before & after", cleanText(config.subtitle));
    const pairs = asArray(data.pairs);
    if (!pairs.length) {
      el.appendChild(h("div", "fmpw-empty", "Before and after photos will appear here."));
      return;
    }
    const layout = ["grid", "slider", "stack"].includes(cleanText(config.layout)) ? cleanText(config.layout) : "grid";
    const grid = h("div", "fmpw-portfolio " + layout);
    if (layout === "grid") grid.style.gridTemplateColumns = `repeat(${Math.max(1, Math.min(4, Number(config.columns) || 2))},minmax(0,1fr))`;
    for (const pair of pairs) {
      const card = h("div", "fmpw-pair");
      if (layout === "slider") {
        const compare = h("div", "fmpw-compare");
        const before = document.createElement("img");
        before.src = cleanText(pair.before_url); before.alt = "Before"; before.loading = "lazy";
        const after = document.createElement("img");
        after.className = "after"; after.src = cleanText(pair.after_url); after.alt = "After"; after.loading = "lazy";
        compare.appendChild(before); compare.appendChild(after);
        if (ctx.mode === "interactive") {
          const range = document.createElement("input");
          range.className = "fmpw-compare-range"; range.type = "range"; range.min = "0"; range.max = "100"; range.value = "50";
          range.setAttribute("aria-label", (globalThis.PlatformLanguage?.text("portal-widgets","m_baefc62ca34761","Compare before and after") ?? "Compare before and after"));
          range.addEventListener("input", () => { after.style.clipPath = `inset(0 ${100 - Number(range.value)}% 0 0)`; });
          compare.appendChild(range);
        }
        card.appendChild(compare);
      } else {
        const imgs = h("div", "fmpw-pair-imgs");
        for (const side of [["before", pair.before_url], ["after", pair.after_url]]) {
          const figure = document.createElement("figure");
          const img = document.createElement("img");
          img.src = cleanText(side[1]);
          img.alt = side[0];
          img.loading = "lazy";
          figure.appendChild(img);
          if (config.show_labels !== false) figure.appendChild(h("figcaption", null, side[0]));
          imgs.appendChild(figure);
        }
        card.appendChild(imgs);
      }
      const label = cleanText(pair.label);
      if (label) card.appendChild(h("div", "fmpw-pair-label", label));
      const caption = cleanText(pair.caption);
      if (caption && config.show_captions !== false) card.appendChild(h("div", "fmpw-pair-caption", caption));
      grid.appendChild(card);
    }
    el.appendChild(grid);
  }

  function renderWelcomeVideo(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    const data = ctx && ctx.data;
    const config = (ctx && ctx.config) || {};
    const configuredSrc = ctx && typeof ctx.mediaUrl === "function" ? cleanText(ctx.mediaUrl(config.media, "original")) : "";
    const src = cleanText(data && data.url) || configuredSrc;
    if (!src) {
      if (ctx && ctx.preview === true) {
        sectionHead(el, cleanText(config.title), cleanText(config.subtitle));
        const wrap = h("div", "fmpw-video");
        const visual = h("div", "fmpw-video-placeholder");
        const copy = h("div");
        copy.appendChild(icon("fa-play"));
        copy.appendChild(h("strong", null, "Welcome video"));
        copy.appendChild(h("span", null, "Choose or upload a video to replace this preview."));
        visual.appendChild(copy); wrap.appendChild(visual); el.appendChild(wrap);
        const caption = cleanText(config.caption);
        if (caption) wrap.appendChild(h("div", "fmpw-video-caption", caption));
        return;
      }
      placeholder(el, "Welcome video", "Pick a video in the widget settings.");
      return;
    }
    sectionHead(el, cleanText(config.title), cleanText(config.subtitle));
    const wrap = h("div", "fmpw-video");
    const video = document.createElement("video");
    video.src = src;
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    const poster = cleanText(data && data.poster_url);
    if (poster) video.poster = poster;
    // Autoplay only ever muted: an unmuted autoplay is blocked by browsers and
    // is hostile in a portal a customer opened to read something.
    if (config.autoplay === true) {
      video.muted = true;
      video.autoplay = true;
    }
    wrap.appendChild(video);
    el.appendChild(wrap);
    const caption = cleanText(config.caption);
    if (caption) {
      const captionEl = h("div", "fmpw-video-caption", caption);
      wrap.appendChild(captionEl);
    }
  }

  function renderNearbyJobs(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    let data = ctx && ctx.data;
    const config = (ctx && ctx.config) || {};
    if (!data && ctx && ctx.preview === true) data = {
      center: { lat: 34.0522, lng: -118.2437 },
      jobs: [
        { label: (globalThis.PlatformLanguage?.text("portal-widgets","m_5210374649bdeb","Completed exterior renovation") ?? "Completed exterior renovation"), neighborhood: "Northwood", distance_miles: 1.8, project_type: "Exterior", lat: 34.061, lng: -118.255 },
        { label: (globalThis.PlatformLanguage?.text("portal-widgets","m_ef137a81e6c3a3","Recent roofing project") ?? "Recent roofing project"), neighborhood: "Oak Ridge", distance_miles: 3.4, project_type: "Roofing", lat: 34.044, lng: -118.229 },
        { label: (globalThis.PlatformLanguage?.text("portal-widgets","m_cb661cc7a15fe0","Active window installation") ?? "Active window installation"), neighborhood: "Cedar Park", distance_miles: 4.7, project_type: "Windows", lat: 34.067, lng: -118.218 }
      ]
    };
    if (!data) {
      placeholder(el, "Nearby projects", "Shows privacy-safe showcase projects near this customer.");
      return;
    }
    sectionHead(el, cleanText(config.title) || "Work near you", cleanText(config.subtitle));
    const jobs = asArray(data.jobs);
    if (!jobs.length) {
      el.appendChild(h("div", "fmpw-empty", "No showcase projects match these settings yet."));
      return;
    }
    if (cleanText(config.layout) !== "list") {
      const map = h("div", "fmpw-nearby-map");
      if (cleanText(data.map_image_url)) {
        const image = document.createElement("img");
        image.src = cleanText(data.map_image_url); image.alt = "Map of nearby completed projects"; image.loading = "lazy";
        map.appendChild(image);
      } else {
        const plot = h("div", "fmpw-map-plot");
        const points = [{ lat: Number(data.center && data.center.lat), lng: Number(data.center && data.center.lng), you: true }]
          .concat(jobs.map((job) => ({ lat: Number(job.lat), lng: Number(job.lng), you: false })));
        const lats = points.map((point) => point.lat); const lngs = points.map((point) => point.lng);
        const minLat = Math.min(...lats); const maxLat = Math.max(...lats); const minLng = Math.min(...lngs); const maxLng = Math.max(...lngs);
        points.forEach((point) => {
          const pin = h("span", "fmpw-map-pin" + (point.you ? " you" : ""));
          pin.style.left = `${12 + ((point.lng - minLng) / Math.max(.001, maxLng - minLng)) * 76}%`;
          pin.style.top = `${88 - ((point.lat - minLat) / Math.max(.001, maxLat - minLat)) * 76}%`;
          plot.appendChild(pin);
        });
        map.appendChild(plot);
      }
      el.appendChild(map);
    }
    const list = h("div", "fmpw-nearby-list");
    jobs.forEach((job) => {
      const row = h("article", "fmpw-nearby-job" + (cleanText(job.thumbnail_url) ? "" : " no-photo"));
      if (cleanText(job.thumbnail_url)) {
        const image = document.createElement("img"); image.src = cleanText(job.thumbnail_url); image.alt = ""; image.loading = "lazy"; row.appendChild(image);
      }
      const body = h("div"); body.appendChild(h("strong", null, cleanText(job.label) || "Completed project"));
      const meta = [cleanText(job.neighborhood), Number(job.distance_miles) >= 0 ? `${Number(job.distance_miles).toFixed(1)} mi away` : "", cleanText(job.project_type).replace(/_/g, " ")].filter(Boolean);
      body.appendChild(h("span", null, meta.join(" · "))); row.appendChild(body); list.appendChild(row);
    });
    if (cleanText(config.layout) !== "map") el.appendChild(list);
    el.appendChild(h("p", "fmpw-privacy", "Locations are intentionally approximate. Customer names and full addresses are never shown."));
  }

  function renderRecurring(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    const data = ctx && ctx.data;
    const config = (ctx && ctx.config) || {};
    if (!data) {
      placeholder(el, "Recurring visits", "Shows this project's recurring visit schedule.");
      return;
    }
    sectionHead(el, cleanText(config.title) || "Your recurring visits", cleanText(config.subtitle));
    const series = asArray(data.series);
    if (!series.length) {
      el.appendChild(h("div", "fmpw-empty", "No recurring visits are scheduled."));
      return;
    }
    const wrap = h("div", "fmpw-recurring");
    for (const entry of series) {
      const row = h("div", "fmpw-series");
      const dot = h("div", "fmpw-dot");
      dot.appendChild(icon("fa-arrows-rotate"));
      row.appendChild(dot);
      const body = h("div");
      body.appendChild(h("strong", null, cleanText(entry.title) || "Recurring visit"));
      const parts = [];
      if (cleanText(entry.cadence)) parts.push(cleanText(entry.cadence));
      const next = formatDate(entry.next_at);
      if (next) parts.push("Next visit " + next);
      if (parts.length) body.appendChild(h("span", null, parts.join(" · ")));
      row.appendChild(body);
      wrap.appendChild(row);
    }
    el.appendChild(wrap);
  }

  // ---------------------------------------------------------------------------
  // Home essentials
  //
  // These render `ctx.portal.views` — models the portal computes from the
  // payload it already holds. No server resolver and no second copy of the
  // rules for "what is the next step". Outside a portal there is no views
  // object, so they degrade to a placeholder like every other portal.* widget.
  // ---------------------------------------------------------------------------

  function views(ctx) {
    return (ctx && ctx.portal && ctx.portal.views) || null;
  }

  function renderProjectHeader(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    const config = (ctx && ctx.config) || {};
    const model = views(ctx) && views(ctx).project;
    if (!model) {
      placeholder(el, "Project header", "Shows the project name, address, and contact.");
      return;
    }
    const card = h("div", "fmpw-project-header");
    const main = h("div");
    main.appendChild(h("h2", null, cleanText(model.name) || "Your project"));
    if (cleanText(model.address)) main.appendChild(h("p", null, cleanText(model.address)));
    card.appendChild(main);

    const contact = h("dl", "fmpw-contact");
    const rows = [
      ["Contact", cleanText(model.customer_name)],
      ["Email", cleanText(model.customer_email)],
      ["Phone", cleanText(model.customer_phone)]
    ].filter((row) => row[1]);
    for (const [label, value] of rows) {
      contact.appendChild(h("dt", null, label));
      contact.appendChild(h("dd", null, value));
    }
    if (rows.length && config.show_contact !== false) card.appendChild(contact);
    el.appendChild(card);
  }

  function renderNextSteps(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    const model = views(ctx) && views(ctx).next_steps;
    const config = (ctx && ctx.config) || {};
    if (!model) {
      placeholder(el, "Next steps", "Shows the customer where they are in the job.");
      return;
    }
    if (!model.length) {
      sectionHead(el, cleanText(config.title) || "Next steps");
      el.appendChild(h("div", "fmpw-empty", "Nothing needs your attention right now."));
      return;
    }
    const done = model.filter((step) => step.complete).length;
    const head = h("div", "fmpw-head fmpw-head-row");
    const heading = h("div");
    heading.appendChild(h("h3", null, cleanText(config.title) || "Next steps"));
    head.appendChild(heading);
    head.appendChild(h("span", "fmpw-progress", `${done}/${model.length}`));
    el.appendChild(head);

    const firstOpen = model.find((step) => !step.complete && !step.disabled);
    const list = h("div", "fmpw-steps");
    for (const step of model) {
      const row = h("button", `fmpw-step${step.complete ? " done" : ""}${firstOpen && step.id === firstOpen.id ? " current" : ""}`);
      row.type = "button";
      if (step.disabled) row.disabled = true;
      const mark = h("span", "fmpw-step-dot");
      mark.appendChild(icon(step.complete ? "fa-circle-check" : "fa-circle"));
      row.appendChild(mark);
      const copy = h("span", "fmpw-step-copy");
      copy.appendChild(h("strong", null, cleanText(step.label)));
      if (cleanText(step.detail)) copy.appendChild(h("small", null, cleanText(step.detail)));
      row.appendChild(copy);
      // Steps deep-link into the tab that actually resolves them.
      if (cleanText(step.tab) && ctx.portal && typeof ctx.portal.openTab === "function" && ctx.mode === "interactive") {
        row.addEventListener("click", () => ctx.portal.openTab(cleanText(step.tab)));
      } else {
        row.disabled = true;
      }
      list.appendChild(row);
    }
    el.appendChild(list);
  }

  function renderNextAppointment(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    const model = views(ctx) && views(ctx).appointments;
    const config = (ctx && ctx.config) || {};
    if (!model) {
      placeholder(el, "Next visit", "Shows the customer's next scheduled appointment.");
      return;
    }
    sectionHead(el, cleanText(config.title) || "Your next visit");
    if (!model.next) {
      el.appendChild(h("div", "fmpw-empty", "Nothing is scheduled right now — we'll be in touch."));
      return;
    }
    const wrap = h("div", "fmpw-visits");
    for (const event of asArray(model.upcoming)) {
      const row = h("div", "fmpw-visit");
      const dot = h("div", "fmpw-dot");
      dot.appendChild(icon("fa-calendar-day"));
      row.appendChild(dot);
      const body = h("div");
      body.appendChild(h("strong", null, cleanText(event.title) || cleanText(event.customer_description) || "Scheduled visit"));
      const when = formatDateTime(event.start_at || event.start);
      if (when) body.appendChild(h("span", null, when));
      row.appendChild(body);
      wrap.appendChild(row);
    }
    el.appendChild(wrap);
    if (Number(model.total) > asArray(model.upcoming).length && ctx.portal && typeof ctx.portal.openTab === "function" && ctx.mode === "interactive") {
      const more = h("button", "fmpw-link", "See the full schedule");
      more.type = "button";
      more.addEventListener("click", () => ctx.portal.openTab("schedule"));
      el.appendChild(more);
    }
  }

  function renderPhotoStrip(el, ctx) {
    ensureStyles();
    el.innerHTML = "";
    const model = views(ctx) && views(ctx).photos;
    const config = (ctx && ctx.config) || {};
    if (!model) {
      placeholder(el, "Recent photos", "Shows the latest photos shared with the customer.");
      return;
    }
    const head = h("div", "fmpw-head fmpw-head-row");
    const heading = h("div");
    heading.appendChild(h("h3", null, cleanText(config.title) || "Recent photos"));
    head.appendChild(heading);
    head.appendChild(h("span", "fmpw-progress", String(model.total || 0)));
    el.appendChild(head);

    const items = asArray(model.items);
    if (!items.length) {
      el.appendChild(h("div", "fmpw-empty", "No photos have been shared yet."));
      return;
    }
    const strip = h("div", "fmpw-strip");
    for (const item of items) {
      const tile = h("div", "fmpw-strip-tile");
      if (cleanText(item.url)) {
        const img = document.createElement("img");
        img.src = cleanText(item.url);
        img.alt = cleanText(item.label) || "";
        img.loading = "lazy";
        tile.appendChild(img);
      }
      strip.appendChild(tile);
    }
    el.appendChild(strip);
    if (ctx.portal && typeof ctx.portal.openTab === "function" && ctx.mode === "interactive") {
      const more = h("button", "fmpw-link", "View all photos");
      more.type = "button";
      more.addEventListener("click", () => ctx.portal.openTab("photos"));
      el.appendChild(more);
    }
  }

  function formatDateTime(value) {
    const raw = cleanText(value);
    if (!raw) return "";
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  // ---------------------------------------------------------------------------
  // Definitions + registration
  // ---------------------------------------------------------------------------

  const TITLE_FIELDS = [
    { key: "title", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_29dbd3d8b69f55","Title") ?? "Title"), kind: "text" },
    { key: "subtitle", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_d427f431cceece","Subtitle") ?? "Subtitle"), kind: "text" }
  ];

  const DEFINITIONS = [
    {
      id: "portal.project_header",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_f813c3ac52adc1","Project header") ?? "Project header"),
      icon: "fa-house-chimney",
      category: "data",
      defaults: { config: {}, frame: { w: "auto", h: "auto" } },
      configPanel: [{ key: "show_contact", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_18f39a285c14a8","Show contact details") ?? "Show contact details"), kind: "toggle" }],
      renderStatic: renderProjectHeader,
      renderInteractive: renderProjectHeader
    },
    {
      id: "portal.next_steps",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_6ed0ed7b9ec62d","Next steps") ?? "Next steps"),
      icon: "fa-list-check",
      category: "data",
      defaults: { config: { title: (globalThis.PlatformLanguage?.text("portal-widgets","m_6ed0ed7b9ec62d","Next steps") ?? "Next steps") }, frame: { w: "auto", h: "auto" } },
      configPanel: TITLE_FIELDS,
      renderStatic: renderNextSteps,
      renderInteractive: renderNextSteps
    },
    {
      id: "portal.next_appointment",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_ddae45be1df721","Next visit") ?? "Next visit"),
      icon: "fa-calendar-day",
      category: "data",
      defaults: { config: { title: (globalThis.PlatformLanguage?.text("portal-widgets","m_cad0582c296403","Your next visit") ?? "Your next visit") }, frame: { w: "auto", h: "auto" } },
      configPanel: TITLE_FIELDS,
      renderStatic: renderNextAppointment,
      renderInteractive: renderNextAppointment
    },
    {
      id: "portal.photo_strip",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_5679a67ee2d45a","Recent photos") ?? "Recent photos"),
      icon: "fa-images",
      category: "media",
      defaults: { config: { title: (globalThis.PlatformLanguage?.text("portal-widgets","m_5679a67ee2d45a","Recent photos") ?? "Recent photos") }, frame: { w: "auto", h: "auto" } },
      configPanel: TITLE_FIELDS,
      renderStatic: renderPhotoStrip,
      renderInteractive: renderPhotoStrip
    },
    {
      id: "portal.activity_feed",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_ca88698f97c379","Project updates") ?? "Project updates"),
      icon: "fa-timeline",
      category: "data",
      defaults: { config: { title: (globalThis.PlatformLanguage?.text("portal-widgets","m_ca88698f97c379","Project updates") ?? "Project updates"), limit: 10 }, frame: { w: 420, h: 300 } },
      configPanel: TITLE_FIELDS.concat([
        { key: "source_mode", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_762f3d865e9f45","Updates") ?? "Updates"), kind: "select", options: [["automatic", "Project activity"], ["manual", "Manual updates"], ["hybrid", "Project + manual"]] },
        { key: "layout", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_f309f6468d8a53","Layout") ?? "Layout"), kind: "select", options: [["timeline", "Timeline"], ["cards", "Cards"], ["compact", "Compact"]] },
        { key: "limit", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_44c2e0d5423f4e","Entries") ?? "Entries"), kind: "number", min: 1, max: 50 },
        { key: "days_back", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_b8680a93e9e2c4","Only the last (days)") ?? "Only the last (days)"), kind: "number", min: 0, max: 3650 },
        { key: "show_dates", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_b2b43748f3cab3","Show dates") ?? "Show dates"), kind: "toggle" },
        { key: "show_details", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_11baa3968d1901","Show details") ?? "Show details"), kind: "toggle" },
        { key: "newest_first", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_20923367c9f84a","Newest first") ?? "Newest first"), kind: "toggle" },
        { key: "event_types", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_b3065c826eebf3","Event types (blank = all)") ?? "Event types (blank = all)"), kind: "list" },
        { key: "manual_entries", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_eccc138657c5df","Manual updates") ?? "Manual updates"), kind: "list", itemLabel: "Update", itemFields: [
          { key: "label", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_f2b1764fc05842","Headline") ?? "Headline"), kind: "text" },
          { key: "detail", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_b3ecc234f63212","Details") ?? "Details"), kind: "text" },
          { key: "date", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_2a0b11100c22a4","Date") ?? "Date"), kind: "text", placeholder: "2026-08-01" },
          { key: "icon", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_59ff4c5cbd469b","Icon class") ?? "Icon class"), kind: "text", placeholder: (globalThis.PlatformLanguage?.text("portal-widgets","m_c367d15be51f9d","fa-circle-check") ?? "fa-circle-check") }
        ] }
      ]),
      renderStatic: renderActivityFeed,
      renderInteractive: renderActivityFeed
    },
    {
      id: "portal.reviews",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_44dc424938cc5f","Reviews") ?? "Reviews"),
      icon: "fa-star",
      category: "data",
      defaults: { config: { title: (globalThis.PlatformLanguage?.text("portal-widgets","m_88b0773508ad8a","What customers say") ?? "What customers say"), limit: 3, show_summary: true }, frame: { w: 420, h: 320 } },
      configPanel: TITLE_FIELDS.concat([
        { key: "show_summary", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_2a5660a6c0d7aa","Show rating summary") ?? "Show rating summary"), kind: "toggle" },
        { key: "limit", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_699da9e9837fa5","Reviews shown") ?? "Reviews shown"), kind: "number", min: 0, max: 20 }
      ]),
      renderStatic: renderReviews,
      renderInteractive: renderReviews
    },
    {
      id: "portal.team",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_c3ed44a81e65c7","Meet the team") ?? "Meet the team"),
      icon: "fa-people-group",
      category: "data",
      defaults: { config: { title: (globalThis.PlatformLanguage?.text("portal-widgets","m_d9d96a5d199ea6","Meet your team") ?? "Meet your team"), source_mode: "automatic", layout: "cards", columns: 3, photo_shape: "round", show_role: true, show_bio: false, limit: 12, selected_user_ids: [], manual_members: [] }, frame: { w: 520, h: 300 } },
      configPanel: TITLE_FIELDS.concat([
        { key: "source_mode", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_57420a03b49adf","People") ?? "People"), kind: "select", options: [["automatic", "Assigned team"], ["manual", "Manual people"], ["hybrid", "Assigned + manual"]] },
        { key: "selected_user_ids", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_532df19c2a90fe","Always include users") ?? "Always include users"), kind: "list" },
        { key: "layout", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_f309f6468d8a53","Layout") ?? "Layout"), kind: "select", options: [["cards", "Cards"], ["list", "Compact list"]] },
        { key: "columns", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_8abb9612e904f8","Columns") ?? "Columns"), kind: "number", min: 1, max: 4 },
        { key: "photo_shape", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_188b956d952dbf","Photo shape") ?? "Photo shape"), kind: "select", options: [["round", "Round"], ["square", "Rounded square"]] },
        { key: "show_role", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_e5a349a8f4c87f","Show roles") ?? "Show roles"), kind: "toggle" },
        { key: "show_bio", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_86c7dcef0b9371","Show bios") ?? "Show bios"), kind: "toggle" },
        { key: "limit", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_53cd9abc03040b","Maximum people") ?? "Maximum people"), kind: "number", min: 1, max: 24 },
        { key: "manual_members", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_ed8df02d80609c","Manual people") ?? "Manual people"), kind: "list", itemLabel: "Person", itemFields: [
          { key: "name", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_8cf345002184e5","Name") ?? "Name"), kind: "text" },
          { key: "role", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_17b51e98936157","Role") ?? "Role"), kind: "text" },
          { key: "bio", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_9ea54be82becd8","Bio") ?? "Bio"), kind: "text" },
          { key: "photo", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_9aa4740fd235ab","Photo") ?? "Photo"), kind: "media", accept: "image/*" }
        ] }
      ]),
      renderStatic: renderTeam,
      renderInteractive: renderTeam
    },
    {
      id: "portal.portfolio",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_676444cb208706","Before & after") ?? "Before & after"),
      icon: "fa-images",
      category: "media",
      defaults: { config: { title: (globalThis.PlatformLanguage?.text("portal-widgets","m_676444cb208706","Before & after") ?? "Before & after"), source_mode: "automatic", layout: "slider", columns: 2, limit: 4, before_tag: "before", after_tag: "after", show_labels: true, show_captions: true, manual_pairs: [] }, frame: { w: 560, h: 360 } },
      configPanel: TITLE_FIELDS.concat([
        { key: "source_mode", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_be4cfb58b9c4d7","Photos") ?? "Photos"), kind: "select", options: [["automatic", "Tagged project photos"], ["manual", "Manual pairs"], ["hybrid", "Manual + tagged"]] },
        { key: "layout", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_f309f6468d8a53","Layout") ?? "Layout"), kind: "select", options: [["slider", "Comparison slider"], ["grid", "Side-by-side grid"], ["stack", "Full-width stack"]] },
        { key: "columns", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_0de5753cce2315","Grid columns") ?? "Grid columns"), kind: "number", min: 1, max: 4 },
        { key: "limit", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_bcc98bf2a64ae6","Pairs shown") ?? "Pairs shown"), kind: "number", min: 1, max: 24 },
        { key: "before_tag", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_5371867c45e425","Before tag") ?? "Before tag"), kind: "text" },
        { key: "after_tag", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_bafeedb347849c","After tag") ?? "After tag"), kind: "text" },
        { key: "show_labels", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_67c368297006ad","Show Before / After labels") ?? "Show Before / After labels"), kind: "toggle" },
        { key: "show_captions", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_9d00dd40ea69a0","Show captions") ?? "Show captions"), kind: "toggle" },
        { key: "manual_pairs", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_1504757e2af40f","Manual pairs") ?? "Manual pairs"), kind: "list", itemLabel: "Pair", itemFields: [
          { key: "label", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_29dbd3d8b69f55","Title") ?? "Title"), kind: "text" },
          { key: "caption", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_8e5d22e5fc5931","Caption") ?? "Caption"), kind: "text" },
          { key: "before", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_5deeae9c59d0ca","Before image") ?? "Before image"), kind: "media", accept: "image/*" },
          { key: "after", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_da882827c97e39","After image") ?? "After image"), kind: "media", accept: "image/*" }
        ] }
      ]),
      renderStatic: renderPortfolio,
      renderInteractive: renderPortfolio
    },
    {
      id: "portal.welcome_video",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_6c5b896fd8bc22","Welcome video") ?? "Welcome video"),
      icon: "fa-circle-play",
      category: "media",
      defaults: { config: { media: null, autoplay: false }, frame: { w: 480, h: 300 } },
      configPanel: TITLE_FIELDS.concat([
        { key: "media", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_254c9a073d4804","Video") ?? "Video"), kind: "media", accept: "video/*" },
        { key: "caption", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_8e5d22e5fc5931","Caption") ?? "Caption"), kind: "text" },
        { key: "autoplay", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_70b40230c1f824","Autoplay (muted)") ?? "Autoplay (muted)"), kind: "toggle" }
      ]),
      renderStatic: renderWelcomeVideo,
      renderInteractive: renderWelcomeVideo
    },
    {
      id: "portal.nearby_jobs",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_0a9f4c82c29bff","Nearby projects") ?? "Nearby projects"),
      icon: "fa-map-location-dot",
      category: "data",
      defaults: { config: { title: (globalThis.PlatformLanguage?.text("portal-widgets","m_70f254abda010f","Work near you") ?? "Work near you"), radius_miles: 10, limit: 8, selection_mode: "automatic", selected_project_ids: [], project_types: [], statuses: ["active", "completed"], layout: "map_list", show_thumbnails: true }, frame: { w: 560, h: 420 } },
      configPanel: TITLE_FIELDS.concat([
        { key: "selection_mode", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_19156e80fc8a6e","Projects") ?? "Projects"), kind: "select", options: [["automatic", "Showcase-enabled projects"], ["selected", "Selected projects"], ["hybrid", "Showcase-enabled + selected"]] },
        { key: "selected_project_ids", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_6bb78e98ea81ea","Selected projects") ?? "Selected projects"), kind: "list", itemLabel: "Project", itemFields: [{ key: "project_id", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_1d668ae64b37c0","Project ID") ?? "Project ID"), kind: "text" }] },
        { key: "radius_miles", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_2ec49ec8094c6e","Radius (miles)") ?? "Radius (miles)"), kind: "number", min: 0.5, max: 100, step: 0.5 },
        { key: "limit", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_22559b030a5220","Projects shown") ?? "Projects shown"), kind: "number", min: 1, max: 30 },
        { key: "project_types", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_e6dddbd05a26ee","Project types (blank = all)") ?? "Project types (blank = all)"), kind: "list" },
        { key: "statuses", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_092a4fcd4415b5","Project statuses") ?? "Project statuses"), kind: "list" },
        { key: "layout", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_f309f6468d8a53","Layout") ?? "Layout"), kind: "select", options: [["map_list", "Map + project cards"], ["map", "Map"], ["list", "Project cards"]] },
        { key: "show_thumbnails", label: (globalThis.PlatformLanguage?.text("portal-widgets","m_df0b99f4b64ed2","Show project photos") ?? "Show project photos"), kind: "toggle" }
      ]),
      renderStatic: renderNearbyJobs,
      renderInteractive: renderNearbyJobs
    },
    {
      id: "portal.recurring",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("portal-widgets","m_a1ff2c5a17fee0","Recurring visits") ?? "Recurring visits"),
      icon: "fa-arrows-rotate",
      category: "data",
      defaults: { config: { title: (globalThis.PlatformLanguage?.text("portal-widgets","m_ec8dc773c83586","Your recurring visits") ?? "Your recurring visits") }, frame: { w: 420, h: 200 } },
      configPanel: TITLE_FIELDS,
      renderStatic: renderRecurring,
      renderInteractive: renderRecurring
    }
  ];

  function registerAll(lib) {
    const target = lib || widgetsLib();
    if (!target || typeof target.register !== "function") return false;
    for (const def of DEFINITIONS) target.register(def);
    return true;
  }

  const registered = registerAll(null);
  if (!registered && root && root.console) {
    root.console.warn("[FirstMatePortalWidgets] FMDocWidgets registry not found — load doc-widgets first (portal.* widgets not registered)");
  }

  return {
    version: 1,
    ids: DEFINITIONS.map(function (def) { return def.id; }),
    definitions: DEFINITIONS,
    // Manual wiring hook for hosts with unusual load orders / headless use.
    register: registerAll
  };
});
