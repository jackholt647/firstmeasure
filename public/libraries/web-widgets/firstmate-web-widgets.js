/**
 * FirstMate web widgets — website-builder widget pack for the document engine
 * (global FirstMateWebWidgets).
 *
 * Registers `web.*` widgets into the SAME FMDocWidgets registry that
 * doc-widgets fills (load AFTER doc-widgets; the registry is shared so the
 * renderer/editor need no special casing). Contract:
 * docs/document-engine-contracts.md §2 (widget shape/ctx) and §10 (web.*).
 *
 * Widgets:
 *   web.lead_form — mounts the public lead-capture embed
 *                   (libraries/lead-embed/firstmate-lead-embed.js, lazy-loaded
 *                   relative to this script's own URL) in interactive mode;
 *                   static/editor renders a labeled placeholder card.
 *   web.nav_menu  — renders site navigation links from server-resolved
 *                   ctx.data.links, falling back to ctx.scope.site.nav and a
 *                   neutral placeholder in the editor.
 *
 * CSS is embedded and self-injected (<style id="fm-web-widgets-styles">) per
 * the library CSS rule — no standalone stylesheet is ever fetched.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FirstMateWebWidgets = api;
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

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  }

  // Resolve sibling library URLs against this script's own src so the pack
  // works from any host page (portal, public site shell, previews).
  const SCRIPT_SRC = (function () {
    try {
      if (typeof document !== "undefined" && document.currentScript && document.currentScript.src) {
        return document.currentScript.src;
      }
      if (typeof document !== "undefined") {
        const tag = document.querySelector('script[src*="firstmate-web-widgets"]');
        if (tag && tag.src) return tag.src;
      }
    } catch (error) {
      /* fall through to root-absolute default */
    }
    return "";
  })();

  function siblingLibraryUrl(rel) {
    if (SCRIPT_SRC) {
      try {
        return new URL("../" + rel, SCRIPT_SRC).toString();
      } catch (error) {
        /* fall through */
      }
    }
    return "/libraries/" + rel;
  }

  /** Lead-intake API base mirroring lead-embed's own localhost switch, derived
   *  from this script's origin (robust when lead-embed is lazy-injected and
   *  can no longer see its own script tag). */
  function leadIntakeBaseUrl() {
    try {
      const src = new URL(SCRIPT_SRC || (root.location && root.location.href) || "", root.location ? root.location.href : undefined);
      if (src.hostname === "localhost" || src.hostname === "127.0.0.1") {
        return src.protocol + "//" + src.hostname + ":3101/v1/lead-intake";
      }
      return src.origin + "/v1/lead-intake";
    } catch (error) {
      return "/v1/lead-intake";
    }
  }

  let leadEmbedPromise = null;
  function ensureLeadEmbed() {
    if (root && root.FirstMateLeadEmbed) return Promise.resolve(root.FirstMateLeadEmbed);
    if (leadEmbedPromise) return leadEmbedPromise;
    leadEmbedPromise = new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      script.src = siblingLibraryUrl("lead-embed/firstmate-lead-embed.js");
      script.async = true;
      script.onload = function () {
        if (root.FirstMateLeadEmbed) resolve(root.FirstMateLeadEmbed);
        else reject(new Error("lead-embed loaded without its global"));
      };
      script.onerror = function () {
        leadEmbedPromise = null;
        reject(new Error("Failed to load firstmate-lead-embed.js"));
      };
      document.head.appendChild(script);
    });
    return leadEmbedPromise;
  }

  // ---------------------------------------------------------------------------
  // Styles — embedded + self-injected once per document.
  // ---------------------------------------------------------------------------

  const STYLE_ELEMENT_ID = "fm-web-widgets-styles";
  const WEB_WIDGETS_CSS = `
/* ── web.lead_form placeholder card ─────────────────────────────────────── */
.fm-webw-lead { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6pt; width: 100%; height: 100%; padding: 14pt; box-sizing: border-box; border: 0.8pt dashed rgba(17, 24, 39, 0.22); border-radius: 8pt; background: rgba(17, 24, 39, 0.02); text-align: center; }
.fm-webw-lead-icon { display: grid; place-items: center; width: 26pt; height: 26pt; border-radius: 999pt; background: rgba(37, 99, 235, 0.1); color: var(--fm-primary, #2563eb); font-size: 12pt; }
.fm-webw-lead-title { font-size: 10.5pt; font-weight: 800; color: #111827; }
.fm-webw-lead-note { font-size: 8pt; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #667085; }
.fm-webw-lead-mount { width: 100%; height: 100%; }
.fm-webw-lead-mount > * { max-width: 100%; }
/* ── web.nav_menu ───────────────────────────────────────────────────────── */
.fm-webw-nav { display: flex; flex-wrap: wrap; align-items: center; width: 100%; height: 100%; margin: 0; padding: 0; box-sizing: border-box; }
.fm-webw-nav--vertical { flex-direction: column; flex-wrap: nowrap; justify-content: flex-start; }
.fm-webw-nav-link { display: inline-flex; align-items: center; color: var(--fmdoc-text, #111827); text-decoration: none; font-weight: 700; font-size: 10.5pt; line-height: 1.3; white-space: nowrap; }
.fm-webw-nav-link:hover { color: var(--fm-primary, #2563eb); }
.fm-webw-nav--pill .fm-webw-nav-link { padding: 3pt 9pt; border-radius: 999pt; }
.fm-webw-nav--pill .fm-webw-nav-link:hover { background: rgba(37, 99, 235, 0.08); }
.fm-webw-nav--underline .fm-webw-nav-link { text-decoration: none; }
.fm-webw-nav--underline .fm-webw-nav-link:hover { text-decoration: underline; text-underline-offset: 3pt; }
.fm-webw-nav-empty { font-size: 8.5pt; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #98a2b3; }
.fm-webw-page-embed { width: 100%; height: 100%; box-sizing: border-box; overflow: hidden; background: #fff; }
.fm-webw-page-embed-placeholder { display: flex; align-items: center; justify-content: center; gap: 8pt; width: 100%; height: 100%; box-sizing: border-box; border: 0.8pt dashed rgba(17,24,39,.24); background: rgba(17,24,39,.025); color: #667085; font-size: 9pt; font-weight: 750; }
`;

  function ensureStyles(doc) {
    if (!doc || typeof doc.getElementById !== "function" || doc.getElementById(STYLE_ELEMENT_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent = WEB_WIDGETS_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function clearEl(el) {
    if (el && el.ownerDocument) ensureStyles(el.ownerDocument);
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // ---------------------------------------------------------------------------
  // web.lead_form
  // ---------------------------------------------------------------------------

  function leadFormPlaceholder(el, ctx, note) {
    clearEl(el);
    const card = h("div", "fm-webw-lead");
    const icon = h("div", "fm-webw-lead-icon");
    // FontAwesome glyph (host pages load FA); degrades to an empty disc.
    const fa = h("i", "fa-solid fa-envelope-open-text");
    fa.setAttribute("aria-hidden", "true");
    icon.appendChild(fa);
    card.appendChild(icon);
    const title = cleanText(ctx.data && ctx.data.form_title) || "Lead form";
    card.appendChild(h("div", "fm-webw-lead-title", title));
    card.appendChild(h("div", "fm-webw-lead-note", note));
    el.appendChild(card);
  }

  function renderLeadFormStatic(el, ctx) {
    const formId = cleanText(ctx.config && ctx.config.form_id);
    if (!formId) {
      leadFormPlaceholder(el, ctx, "Pick a form in the widget settings");
      return;
    }
    const available = !ctx.data || ctx.data.available !== false;
    leadFormPlaceholder(el, ctx, available ? "Form loads here on the live site" : "Selected form is unavailable");
  }

  function renderLeadFormInteractive(el, ctx) {
    const formId = cleanText(ctx.config && ctx.config.form_id);
    if (!formId || (ctx.data && ctx.data.available === false)) {
      renderLeadFormStatic(el, ctx);
      return;
    }
    clearEl(el);
    const mount = h("div", "fm-webw-lead-mount");
    el.appendChild(mount);
    let cancelled = false;
    ensureLeadEmbed()
      .then(function (lib) {
        if (cancelled || !mount.isConnected) return;
        return lib.render({ formId: formId, target: mount, baseUrl: leadIntakeBaseUrl() });
      })
      .catch(function () {
        if (cancelled) return;
        leadFormPlaceholder(el, ctx, "Form could not be loaded");
      });
    return {
      destroy: function () {
        cancelled = true;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // web.nav_menu
  // ---------------------------------------------------------------------------

  const NAV_PLACEHOLDER_LINKS = [
    { title: (globalThis.PlatformLanguage?.text("web-widgets","m_1519fbdf5b87ed","Home") ?? "Home"), slug: "" },
    { title: (globalThis.PlatformLanguage?.text("web-widgets","m_6298b036d85064","About") ?? "About"), slug: "about" },
    { title: (globalThis.PlatformLanguage?.text("web-widgets","m_46c8aea84388c3","Contact") ?? "Contact"), slug: "contact" }
  ];

  function navLinks(ctx) {
    if (ctx.data && Array.isArray(ctx.data.links) && ctx.data.links.length) return ctx.data.links;
    const siteNav = ctx.scope && ctx.scope.site && ctx.scope.site.nav;
    if (Array.isArray(siteNav) && siteNav.length) return siteNav;
    return NAV_PLACEHOLDER_LINKS;
  }

  /** Href finalization mirrors doc-renderer's props.link resolution: prefer
   *  the host's resolvePageHref(slug) (site runtime / portal supply it), then
   *  a server-resolved absolute/relative href, else a non-navigating "#". */
  function navHref(link, ctx) {
    const slug = cleanText(link.slug);
    if ((slug || link.slug === "") && typeof ctx.resolvePageHref === "function") {
      try {
        const resolved = cleanText(ctx.resolvePageHref(slug));
        if (resolved) return resolved;
      } catch (error) {
        /* fall through */
      }
    }
    const href = cleanText(link.href);
    return href || "#";
  }

  function renderNavMenu(el, ctx) {
    clearEl(el);
    const config = ctx.config || {};
    const layout = config.layout === "vertical" ? "vertical" : "horizontal";
    const linkStyle = config.link_style === "pill" ? "pill" : config.link_style === "underline" ? "underline" : "plain";
    const nav = h("nav", "fm-webw-nav fm-webw-nav--" + layout + " fm-webw-nav--" + linkStyle);
    const gap = Number(config.gap_pt);
    nav.style.gap = (Number.isFinite(gap) && gap >= 0 ? gap : 14) + "pt";
    const align = config.align === "center" ? "center" : config.align === "right" ? "flex-end" : "flex-start";
    if (layout === "vertical") nav.style.alignItems = align;
    else nav.style.justifyContent = align;

    const links = navLinks(ctx);
    if (!links.length) {
      nav.appendChild(h("span", "fm-webw-nav-empty", "No menu pages yet"));
      el.appendChild(nav);
      return;
    }
    for (const link of links) {
      const a = h("a", "fm-webw-nav-link", cleanText(link.title) || cleanText(link.slug) || "Page");
      const href = navHref(link, ctx);
      a.setAttribute("href", href);
      a.addEventListener("click", function (ev) {
        // Placeholder links never navigate; under an editor canvas real links
        // must keep selecting instead of navigating (same rule as the
        // renderer's node-link guard).
        if (href === "#" || a.closest(".fmde-root, [data-fmde]")) ev.preventDefault();
      });
      nav.appendChild(a);
    }
    el.appendChild(nav);
  }

  // ---------------------------------------------------------------------------
  // web.page_embed
  // ---------------------------------------------------------------------------

  function renderPageEmbedPlaceholder(el, ctx, note) {
    clearEl(el);
    const box = h("div", "fm-webw-page-embed-placeholder");
    const icon = h("i", "fa-solid fa-window-restore");
    icon.setAttribute("aria-hidden", "true");
    box.appendChild(icon);
    box.appendChild(h("span", "", cleanText(ctx.data && ctx.data.page_title) || note || "Choose a page to embed"));
    el.appendChild(box);
  }

  function renderPageEmbedStatic(el, ctx) {
    renderPageEmbedPlaceholder(el, ctx, cleanText(ctx.config && ctx.config.page_id) ? "Embedded page section" : "Choose a page to embed");
  }

  function renderPageEmbedInteractive(el, ctx) {
    const definition = ctx.data && ctx.data.definition;
    if (!ctx.data || ctx.data.available === false || !definition || !root.FMDocRenderer || typeof root.FMDocRenderer.render !== "function") {
      renderPageEmbedStatic(el, ctx);
      return;
    }
    clearEl(el);
    const mount = h("div", "fm-webw-page-embed");
    el.appendChild(mount);
    const paperWidth = Number(definition.paper && definition.paper.width_pt) || 720;
    const width = Math.max(1, el.clientWidth || mount.clientWidth || paperWidth);
    const handle = root.FMDocRenderer.render(mount, {
      document: definition,
      mode: "interactive",
      widgetData: ctx.data.widget_data || {},
      themeContext: { overrides: ctx.themeVars || {} },
      mediaUrl: ctx.mediaUrl,
      scale: Math.min(1, width / (paperWidth * 96 / 72))
    });
    return { destroy: function () { if (handle && typeof handle.destroy === "function") handle.destroy(); } };
  }

  // ---------------------------------------------------------------------------
  // Definitions + registration
  // ---------------------------------------------------------------------------

  const DEFINITIONS = [
    {
      id: "web.lead_form",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("web-widgets","m_008a2c4a26bebc","Lead form") ?? "Lead form"),
      icon: "fa-envelope-open-text",
      category: "input",
      defaults: { config: { form_id: "" }, frame: { w: 420, h: 400 } },
      // form_id options are baked per-org by the websites catalog endpoint.
      configPanel: [
        { key: "form_id", label: (globalThis.PlatformLanguage?.text("web-widgets","m_fa27f146b32324","Form") ?? "Form"), kind: "select", options: [] }
      ],
      renderStatic: renderLeadFormStatic,
      renderInteractive: renderLeadFormInteractive
    },
    {
      id: "web.nav_menu",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("web-widgets","m_359c0a92e0542d","Navigation menu") ?? "Navigation menu"),
      icon: "fa-bars",
      category: "layout",
      defaults: {
        config: { source: "header", layout: "horizontal", align: "left", gap_pt: 14, link_style: "plain" },
        frame: { w: 420, h: 30 }
      },
      configPanel: [
        { key: "source", label: (globalThis.PlatformLanguage?.text("web-widgets","m_534e86369288e1","Menu") ?? "Menu"), kind: "select", options: [
          { value: "header", label: (globalThis.PlatformLanguage?.text("web-widgets","m_dd2479d2b169d7","Header menu") ?? "Header menu") },
          { value: "footer", label: (globalThis.PlatformLanguage?.text("web-widgets","m_279be10a5e8139","Footer menu") ?? "Footer menu") }
        ] },
        { key: "layout", label: (globalThis.PlatformLanguage?.text("web-widgets","m_f309f6468d8a53","Layout") ?? "Layout"), kind: "select", options: ["horizontal", "vertical"] },
        { key: "align", label: (globalThis.PlatformLanguage?.text("web-widgets","m_142b5b704bcbc8","Align") ?? "Align"), kind: "select", options: ["left", "center", "right"] },
        { key: "gap_pt", label: (globalThis.PlatformLanguage?.text("web-widgets","m_52891e1ddddbf0","Gap (pt)") ?? "Gap (pt)"), kind: "number", min: 0, max: 96 },
        { key: "link_style", label: (globalThis.PlatformLanguage?.text("web-widgets","m_3b0add1852672f","Link style") ?? "Link style"), kind: "select", options: ["plain", "pill", "underline"] }
      ],
      renderStatic: renderNavMenu,
      renderInteractive: renderNavMenu
    },
    {
      id: "web.page_embed",
      version: 1,
      title: (globalThis.PlatformLanguage?.text("web-widgets","m_a6df6708eb66b8","Embedded page section") ?? "Embedded page section"),
      icon: "fa-window-restore",
      category: "layout",
      defaults: { config: { page_id: "" }, frame: { w: 720, h: 360 } },
      configPanel: [
        { key: "page_id", label: (globalThis.PlatformLanguage?.text("web-widgets","m_5f22491fd3f761","Page") ?? "Page"), kind: "select", options: [] }
      ],
      renderStatic: renderPageEmbedStatic,
      renderInteractive: renderPageEmbedInteractive
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
    root.console.warn("[FirstMateWebWidgets] FMDocWidgets registry not found — load doc-widgets first (web.* widgets not registered)");
  }

  return {
    version: 1,
    ids: DEFINITIONS.map(function (def) { return def.id; }),
    definitions: DEFINITIONS,
    // Manual wiring hook for hosts with unusual load orders / headless use.
    register: registerAll
  };
});
