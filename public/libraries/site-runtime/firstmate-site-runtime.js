/**
 * FirstMate site runtime — public hosting shell for websites built with the
 * web builder (global FirstMateSiteRuntime). Spec: docs/web-builder-spec.md §4.
 *
 * boot(config) reads window.__FM_SITE = { siteKey, hostname, pageSlug, basePath, apiBase }:
 *   0. On a custom domain, resolves hostname -> siteKey through the public API.
 *   1. Fetches the site manifest + page payload in parallel (public API,
 *      credentials omitted), then header/footer payloads when published.
 *   2. Renders header + page + footer stacked, each via FMDocRenderer.render
 *      (interactive mode so widgets like web.lead_form work), with
 *      themeContext.overrides = payload theme_vars and a widgetContext
 *      resolvePageHref that finalizes intra-site links off basePath.
 *   3. Responsive: proportional scaling of the design width (Canva-site
 *      behavior) — a ResizeObserver drives handle.setScale(min(1, width /
 *      designPxWidth)) per section; the renderer keeps the wrapper height in
 *      step so the page flows.
 *   4. Sets document.title + meta description from page/site SEO, injects the
 *      chat embed when the manifest carries a widget key, and shows a
 *      friendly 404 panel for unknown/unpublished pages.
 *
 * No SPA routing — links are normal navigations. CSS is embedded and
 * self-injected (<style id="fm-site-runtime-styles">).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FirstMateSiteRuntime = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null, function (root) {
  "use strict";

  const PX_PER_PT = 96 / 72;
  const STYLE_ELEMENT_ID = "fm-site-runtime-styles";

  const RUNTIME_CSS = `
.fm-site { width: 100%; min-height: 100vh; margin: 0; background: #ffffff; }
.fm-site-section { position: relative; width: 100%; overflow: hidden; }
.fm-site-section .fmdoc-root { margin: 0 auto; }
.fm-site-section .fmdoc-page { box-shadow: none; }
/* loading skeleton */
.fm-site-skeleton { max-width: 960px; margin: 0 auto; padding: 48px 24px; display: flex; flex-direction: column; gap: 18px; }
.fm-site-skeleton-bar { border-radius: 10px; background: linear-gradient(90deg, #eef1f5 25%, #f7f9fb 45%, #eef1f5 65%); background-size: 300% 100%; animation: fm-site-shimmer 1.4s ease infinite; }
@keyframes fm-site-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
/* status panels (404 / error) */
.fm-site-panel { max-width: 520px; margin: 12vh auto; padding: 42px 36px; text-align: center; border: 1px solid #e4e7ec; border-radius: 16px; background: #fff; box-shadow: 0 12px 34px rgba(15, 23, 42, 0.08); font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.fm-site-panel-icon { display: grid; place-items: center; width: 52px; height: 52px; margin: 0 auto 16px; border-radius: 999px; background: rgba(37, 99, 235, 0.1); color: var(--fm-primary, #2563eb); font-size: 22px; }
.fm-site-panel-title { margin: 0 0 8px; font-size: 21px; font-weight: 800; color: #111827; }
.fm-site-panel-note { margin: 0 0 20px; font-size: 14px; font-weight: 500; line-height: 1.55; color: #667085; }
.fm-site-panel-link { display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: 10px; background: var(--fm-primary, #2563eb); color: #fff; font-size: 13.5px; font-weight: 700; text-decoration: none; }
.fm-site-panel-link:hover { filter: brightness(1.06); }
`;

  function cleanText(value) {
    return String(value === null || value === undefined ? "" : value).trim();
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  }

  function ensureStyles() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent = RUNTIME_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  const SCRIPT_SRC = (function () {
    try {
      if (typeof document !== "undefined" && document.currentScript && document.currentScript.src) {
        return document.currentScript.src;
      }
      if (typeof document !== "undefined") {
        const tag = document.querySelector('script[src*="firstmate-site-runtime"]');
        if (tag && tag.src) return tag.src;
      }
    } catch (error) {
      /* fall through */
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

  function fetchJson(url) {
    return fetch(url, { credentials: "omit", headers: { Accept: "application/json" } }).then(function (res) {
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
    });
  }

  function modelLib() {
    return (root && root.FMDocModel) || null;
  }

  function rendererLib() {
    return (root && root.FMDocRenderer) || null;
  }

  /** Fluid ("fill") pages span the viewport and reflow — never scaled. */
  function isFillDefinition(definition) {
    const paper = definition && definition.settings && definition.settings.paper;
    return !!paper && paper.size === "fill";
  }

  /** Design pixel width of a view definition (root frame may exceed paper). */
  function designPxWidth(definition) {
    const M = modelLib();
    let wPt = 612;
    try {
      if (M) wPt = M.paperDimensions(definition || {}).w_pt || wPt;
    } catch (error) {
      /* keep default */
    }
    const rootW = definition && definition.root && definition.root.frame && Number(definition.root.frame.w);
    if (Number.isFinite(rootW) && rootW > wPt) wPt = rootW;
    return wPt * PX_PER_PT;
  }

  function setMetaDescription(text) {
    const value = cleanText(text);
    if (!value) return;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "description");
      (document.head || document.documentElement).appendChild(meta);
    }
    meta.setAttribute("content", value);
  }

  function injectChat(widgetKey) {
    const key = cleanText(widgetKey);
    if (!key || document.querySelector('script[data-widget-key][src*="firstmate-chat-embed"]')) return;
    const script = document.createElement("script");
    script.src = siblingLibraryUrl("chat-embed/firstmate-chat-embed.js");
    script.async = true;
    script.setAttribute("data-widget-key", key);
    document.head.appendChild(script);
  }

  function renderSkeleton(mountEl) {
    mountEl.innerHTML = "";
    const wrap = h("div", "fm-site fm-site-loading");
    const skeleton = h("div", "fm-site-skeleton");
    for (const height of [56, 260, 120, 120, 88]) {
      const bar = h("div", "fm-site-skeleton-bar");
      bar.style.height = height + "px";
      skeleton.appendChild(bar);
    }
    wrap.appendChild(skeleton);
    mountEl.appendChild(wrap);
    return wrap;
  }

  function statusPanel(mountEl, options) {
    mountEl.innerHTML = "";
    const wrap = h("div", "fm-site");
    const panel = h("div", "fm-site-panel");
    const icon = h("div", "fm-site-panel-icon");
    const fa = h("i", "fa-solid " + (options.icon || "fa-compass"));
    fa.setAttribute("aria-hidden", "true");
    icon.appendChild(fa);
    panel.appendChild(icon);
    panel.appendChild(h("h1", "fm-site-panel-title", options.title));
    panel.appendChild(h("p", "fm-site-panel-note", options.note));
    if (options.homeHref) {
      const link = h("a", "fm-site-panel-link", options.homeLabel || "Go to the homepage");
      link.setAttribute("href", options.homeHref);
      panel.appendChild(link);
    }
    wrap.appendChild(panel);
    mountEl.appendChild(wrap);
  }

  function boot(config) {
    if (typeof document === "undefined") return Promise.resolve(null);
    ensureStyles();
    const cfg = Object.assign({}, (root && root.__FM_SITE) || {}, config || {});
    const siteKey = cleanText(cfg.siteKey);
    const hostname = cleanText(cfg.hostname || (root && root.location && root.location.hostname)).toLowerCase();
    const pageSlug = cleanText(cfg.pageSlug);
    const basePath = cleanText(cfg.basePath) || (siteKey ? "/sites/" + siteKey + "/" : "/");
    const apiBase = (cleanText(cfg.apiBase) || "/v1/websites").replace(/\/+$/, "");
    const mountEl = document.getElementById("fmSiteRoot") || document.body;

    if (!siteKey) {
      if (!hostname) {
        statusPanel(mountEl, {
          icon: "fa-triangle-exclamation",
          title: "Site not specified",
          note: "This address is missing a website hostname, so there is nothing to show."
        });
        return Promise.resolve(null);
      }
      renderSkeleton(mountEl);
      return fetchJson(apiBase + "/public/host/" + encodeURIComponent(hostname) + "/resolve")
        .then(function (resolution) {
          const resolvedKey = resolution.ok && resolution.body ? cleanText(resolution.body.site_key) : "";
          if (!resolvedKey) {
            statusPanel(mountEl, {
              icon: "fa-compass",
              title: "Website not found",
              note: "No published FirstMate website is connected to this address."
            });
            return null;
          }
          return boot(Object.assign({}, cfg, { siteKey: resolvedKey, hostname: hostname, basePath: basePath }));
        })
        .catch(function () {
          statusPanel(mountEl, {
            icon: "fa-triangle-exclamation",
            title: "Something went wrong",
            note: "This website could not be loaded right now. Please try again in a moment."
          });
          return null;
        });
    }

    const renderer = rendererLib();
    if (!renderer || !modelLib()) {
      statusPanel(mountEl, {
        icon: "fa-triangle-exclamation",
        title: "Something went wrong",
        note: "The page libraries failed to load. Please refresh to try again."
      });
      return Promise.resolve(null);
    }

    renderSkeleton(mountEl);

    const publicBase = apiBase + "/public/site/" + encodeURIComponent(siteKey);
    const pagePath = publicBase + "/page/" + encodeURIComponent(pageSlug || "~home");
    const resolvePageHref = function (slug) {
      const clean = cleanText(slug);
      return basePath + (clean ? encodeURIComponent(clean) : "");
    };

    const handles = [];
    const sections = [];

    function applyScales() {
      const width = mountEl.clientWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
      if (!width) return;
      for (const section of sections) {
        if (section.fill) continue; // fluid pages reflow at width:100%
        const scale = Math.min(1, width / section.designPx);
        try {
          section.handle.setScale(scale);
        } catch (error) {
          /* renderer torn down */
        }
      }
    }

    function renderSection(wrap, payload, manifest) {
      const container = h("div", "fm-site-section-inner");
      const section = h("section", "fm-site-section");
      section.appendChild(container);
      wrap.appendChild(section);
      const themeVars = (payload && payload.theme_vars) || (manifest && manifest.theme_vars) || {};
      const handle = renderer.render(container, {
        document: payload.definition,
        mode: "interactive",
        widgetData: payload.widget_data || {},
        themeContext: { overrides: themeVars },
        widgetContext: { resolvePageHref: resolvePageHref }
      });
      handles.push(handle);
      const entry = { handle: handle, designPx: designPxWidth(payload.definition), fill: isFillDefinition(payload.definition) };
      sections.push(entry);
      const ready = handle && typeof handle.ready === "function" ? handle.ready() : Promise.resolve();
      Promise.resolve(ready).then(applyScales).catch(function () { /* best-effort */ });
      return handle;
    }

    return Promise.all([fetchJson(publicBase + "/manifest"), fetchJson(pagePath)])
      .then(function (results) {
        const manifestRes = results[0];
        const pageRes = results[1];
        const manifest = manifestRes.ok && manifestRes.body ? manifestRes.body : null;

        if (!pageRes.ok) {
          if (pageRes.status === 404) {
            document.title = "Page not found" + (manifest && manifest.name ? " — " + manifest.name : "");
            statusPanel(mountEl, {
              icon: "fa-compass",
              title: "Page not found",
              note: "The page you are looking for is not published or does not exist" + (manifest && manifest.name ? " on " + manifest.name : "") + ".",
              homeHref: basePath,
              homeLabel: "Go to the homepage"
            });
            return null;
          }
          statusPanel(mountEl, {
            icon: "fa-triangle-exclamation",
            title: "Something went wrong",
            note: "This page could not be loaded right now. Please try again in a moment.",
            homeHref: basePath
          });
          return null;
        }
        const page = pageRes.body || {};

        // Header/footer are pages too — fetch only when published.
        const chromeFetches = [
          manifest && manifest.header_published ? fetchJson(publicBase + "/page/~header") : Promise.resolve(null),
          manifest && manifest.footer_published ? fetchJson(publicBase + "/page/~footer") : Promise.resolve(null)
        ];
        return Promise.all(chromeFetches).then(function (chrome) {
          const headerRes = chrome[0];
          const footerRes = chrome[1];

          mountEl.innerHTML = "";
          const wrap = h("div", "fm-site");
          mountEl.appendChild(wrap);

          if (headerRes && headerRes.ok && headerRes.body && headerRes.body.definition) {
            renderSection(wrap, headerRes.body, manifest);
          }
          if (page.definition) renderSection(wrap, page, manifest);
          if (footerRes && footerRes.ok && footerRes.body && footerRes.body.definition) {
            renderSection(wrap, footerRes.body, manifest);
          }

          // SEO: page settings win, then site settings, then names.
          const pageMeta = page.page || {};
          const pageSeo = pageMeta.seo || {};
          const siteSeo = (manifest && manifest.seo) || {};
          document.title =
            cleanText(pageSeo.title) ||
            cleanText(pageMeta.title) ||
            cleanText(siteSeo.title) ||
            cleanText(manifest && manifest.name) ||
            document.title;
          setMetaDescription(pageSeo.description || siteSeo.description);

          if (manifest && manifest.chat && manifest.chat.widget_key) injectChat(manifest.chat.widget_key);

          if (typeof ResizeObserver !== "undefined") {
            const observer = new ResizeObserver(function () { applyScales(); });
            observer.observe(mountEl);
          } else {
            root.addEventListener("resize", applyScales);
          }
          applyScales();
          return { manifest: manifest, page: page, handles: handles };
        });
      })
      .catch(function () {
        statusPanel(mountEl, {
          icon: "fa-triangle-exclamation",
          title: "Something went wrong",
          note: "This site could not be reached. Please check your connection and try again.",
          homeHref: basePath
        });
        return null;
      });
  }

  return {
    version: 1,
    boot: boot
  };
});
