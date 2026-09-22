import type { JsonObject } from "../platform/storage.js";
import { FMDocModel } from "./schemas.js";

/**
 * Starter page definitions for seeded websites. All pages are `kind: "view"`
 * DocModels built through the shared FMDocModel factories so the shapes are
 * valid by construction (and re-validated by the websites test suite).
 *
 * Colors reference the site theme vars (--fm-primary & friends) that the
 * resolution pipeline emits, so re-branding the org restyles the seeds
 * without touching the definitions.
 */

export const WEBSITE_DESIGN_WIDTH_PT = 720;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

type Frame = { x?: number; y?: number; w?: number | "auto"; h?: number | "auto"; z?: number };

function sectionFrame(frame: Frame, flow: JsonObject, extra: JsonObject = {}) {
  return FMDocModel.createNode("frame", {
    frame: { x: 0, y: 0, w: WEBSITE_DESIGN_WIDTH_PT, h: "auto", layout: "flow", ...frame },
    props: {
      flow: { direction: "column", gap: 12, padding: [32, 40, 32, 40], align: "stretch", wrap: false, ...flow }
    },
    ...extra
  });
}

type RunSpec = { text: string; color?: string; weight?: number; font?: JsonObject };

function textNode(runs: RunSpec[], options: JsonObject = {}) {
  const font = asObject(options.font);
  return FMDocModel.createNode("text", {
    frame: { x: 0, y: 0, w: "auto", h: "auto", layout: "flow", ...asObject(options.frame) },
    style: Object.keys(font).length ? { font } : {},
    props: {
      blocks: [{
        id: FMDocModel.generateId("blk"),
        type: cleanText(options.block_type || "paragraph") || "paragraph",
        align: cleanText(options.align || "left") || "left",
        runs: runs.map((run) => ({
          text: run.text,
          ...(run.color ? { color: run.color } : {}),
          ...(run.weight ? { weight: run.weight } : {}),
          ...(run.font ? { font: run.font } : {})
        }))
      }]
    }
  });
}

function navMenuWidget(source: "header" | "footer", layout: "horizontal" | "vertical", extra: JsonObject = {}) {
  return FMDocModel.createNode("widget", {
    frame: { x: 0, y: 0, w: "auto", h: "auto", layout: "flow", ...asObject(extra.frame) },
    props: {
      widget: "web.nav_menu@1",
      config: { source, layout, align: "center", gap_pt: 18, link_style: "plain", ...asObject(extra.config) }
    }
  });
}

function viewDocument(designWidthPt = WEBSITE_DESIGN_WIDTH_PT) {
  const doc = FMDocModel.createDocument({ kind: "view" }) as JsonObject;
  const root = asObject(doc.root);
  root.frame = { ...asObject(root.frame), w: designWidthPt, h: 0, layout: "flow" };
  root.props = {
    ...asObject(root.props),
    flow: { direction: "column", gap: 0, padding: [0, 0, 0, 0], align: "stretch", wrap: false }
  };
  root.children = [];
  doc.root = root;
  // Width-only paper size = the page's design width (paperDimensions handles
  // the h_pt-less object form for view docs).
  doc.settings = { ...asObject(doc.settings), paper: { size: { w_pt: designWidthPt } } };
  doc.metadata = { ...asObject(doc.metadata), surface: "website" };
  return doc;
}

function pushChildren(doc: JsonObject, children: JsonObject[]) {
  const root = asObject(doc.root);
  root.children = children;
  doc.root = root;
  return FMDocModel.normalizeViewHorizontalPositions(doc, { parent_width_pt: WEBSITE_DESIGN_WIDTH_PT });
}

/** Home: primary hero (org-name headline, subline, CTA) + an about section. */
export function homeSeedDefinition(orgName: string) {
  const name = cleanText(orgName) || "Our Company";
  const doc = viewDocument();

  const ctaText = textNode(
    [{ text: "Get in touch", color: "var(--fm-primary, #2563eb)", weight: 800 }],
    { align: "center", font: { size_pt: 12 } }
  );
  const ctaButton = FMDocModel.createNode("frame", {
    name: "CTA",
    frame: { x: 0, y: 0, w: 160, h: "auto", layout: "flow" },
    style: { fill: { type: "solid", color: "#ffffff" }, corner_radius: 6 },
    props: {
      flow: { direction: "column", gap: 0, padding: [10, 18, 10, 18], align: "center", wrap: false },
      link: { page: "contact" }
    },
    children: [ctaText]
  });

  const hero = sectionFrame(
    {},
    { gap: 14, padding: [72, 48, 72, 48], align: "start" },
    {
      name: "Hero",
      style: { fill: { type: "solid", color: "var(--fm-primary, #2563eb)" } }
    }
  );
  hero.children = [
    textNode([{ text: name, color: "#ffffff", weight: 900 }], { font: { size_pt: 34, weight: 900 } }),
    textNode(
      [{ text: "Quality work, honest pricing, and a team that shows up. See what we can do for your home.", color: "rgba(255,255,255,0.92)" }],
      { font: { size_pt: 14 } }
    ),
    ctaButton
  ];

  const about = sectionFrame({}, { gap: 10, padding: [48, 48, 56, 48] }, { name: "About" });
  about.children = [
    textNode([{ text: `About ${name}`, weight: 800 }], { font: { size_pt: 22, weight: 800 } }),
    textNode([
      {
        text: `${name} is a local team that takes pride in doing the job right the first time. ` +
          "From the first walkthrough to the final cleanup, we keep you informed at every step " +
          "and stand behind our work."
      }
    ], { font: { size_pt: 12 } })
  ];

  return pushChildren(doc, [hero, about]);
}

/** Header: horizontal bar with the org name and the header nav menu. */
export function headerSeedDefinition(orgName: string) {
  const name = cleanText(orgName) || "Our Company";
  const doc = viewDocument();
  const bar = sectionFrame(
    {},
    { direction: "row", gap: 24, padding: [18, 40, 18, 40], align: "center" },
    {
      name: "Header",
      style: { fill: { type: "solid", color: "#ffffff" } }
    }
  );
  bar.children = [
    textNode([{ text: name, color: "var(--fm-primary, #2563eb)", weight: 900 }], { font: { size_pt: 16, weight: 900 } }),
    navMenuWidget("header", "horizontal", { config: { align: "end" } })
  ];
  return pushChildren(doc, [bar]);
}

/** Footer: footer nav menu + small print. */
export function footerSeedDefinition(orgName: string) {
  const name = cleanText(orgName) || "Our Company";
  const doc = viewDocument();
  const footer = sectionFrame(
    {},
    { gap: 10, padding: [28, 40, 28, 40], align: "center" },
    {
      name: "Footer",
      style: { fill: { type: "solid", color: "#111827" } }
    }
  );
  footer.children = [
    navMenuWidget("footer", "horizontal"),
    textNode(
      [{ text: `© ${new Date().getFullYear()} ${name}. All rights reserved.`, color: "rgba(255,255,255,0.7)" }],
      { align: "center", font: { size_pt: 9 } }
    )
  ];
  return pushChildren(doc, [footer]);
}

/** New pages start as a titled empty section the editor can build on. */
export function blankPageDefinition(title: string) {
  const doc = viewDocument();
  // New pages are fluid by default — they fill the available width; a fixed
  // width is opt-in from the editor (Page width → Fixed).
  doc.settings = { ...asObject(doc.settings), paper: { size: "fill" } };
  const section = sectionFrame({}, { gap: 10, padding: [48, 48, 48, 48] }, { name: "Section" });
  section.children = [
    textNode([{ text: cleanText(title) || "New page", weight: 800 }], { font: { size_pt: 22, weight: 800 } })
  ];
  return pushChildren(doc, [section]);
}

/**
 * Editable content appended beneath the customer portal's required Summary.
 *
 * The required project header, next steps, photos and proposals are rendered by
 * the portal itself so an editor can never accidentally delete them. This page
 * intentionally starts empty: anything authored here is additional content.
 */
export function portalSummaryExtensionSeedDefinition() {
  const doc = viewDocument();
  doc.settings = { ...asObject(doc.settings), paper: { size: "fill" } };
  doc.metadata = { ...asObject(doc.metadata), surface: "customer_portal_summary", append_only: true };
  return pushChildren(doc, []);
}
