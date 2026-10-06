import type { JsonObject } from "../platform/storage.js";
import { FMDocModel } from "./schemas.js";

/**
 * Builders for seeded templates. Every page holds ONE body region: a flow
 * frame sized to the page style's margins, with the page's content stacked
 * inside it. Content never carries page coordinates, so changing the page
 * style or margins (which re-fits the region frame) moves the whole page with
 * it, and long content paginates through the region.
 */

export type RunSpec = { text?: string; bind?: string; font?: JsonObject; color?: string; weight?: number };
export type BlockSpec = { runs: RunSpec[]; style_ref?: string; align?: string; collapse_empty?: boolean };
type FlowSize = { w?: number; h?: number | "auto"; grow?: number };

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function flowFrame(size: FlowSize = {}): JsonObject {
  return {
    x: 0,
    y: 0,
    w: size.w ?? 0,
    h: size.h ?? "auto",
    z: 0,
    layout: "flow",
    ...(size.grow ? { grow: size.grow } : {})
  };
}

function flowNode(type: string, overrides: JsonObject, size: FlowSize = {}): JsonObject {
  const node = FMDocModel.createNode(type, { ...overrides, frame: flowFrame(size) }) as JsonObject;
  node.anchor = "flow";
  return node;
}

function runList(runs: RunSpec[]) {
  return runs.map((run) => ({
    text: run.text || "",
    ...(run.bind ? { bind: run.bind } : {}),
    ...(run.font ? { font: run.font } : {}),
    ...(run.color ? { color: run.color } : {}),
    ...(run.weight ? { weight: run.weight } : {})
  }));
}

/** Stacked paragraphs in one text node; each block may name its own style. */
export function flowBlocks(blocks: BlockSpec[], options: { font?: JsonObject; align?: string } & FlowSize = {}): JsonObject {
  const font = asObject(options.font);
  return flowNode("text", {
    style: Object.keys(font).length ? { font } : {},
    props: {
      blocks: blocks.map((block) => ({
        id: FMDocModel.generateId("blk"),
        type: "paragraph",
        align: block.align || options.align || "left",
        ...(block.style_ref ? { style_ref: block.style_ref } : {}),
        ...(block.collapse_empty ? { collapse_empty: true } : {}),
        runs: runList(block.runs)
      }))
    }
  }, options);
}

export function flowText(runs: RunSpec[], options: { font?: JsonObject; align?: string; style_ref?: string } & FlowSize = {}): JsonObject {
  return flowBlocks([{ runs, style_ref: options.style_ref }], options);
}

/** Small uppercase label over a value, the pattern every header block uses. */
export function labeledText(label: string, runs: RunSpec[], options: { align?: string; size_pt?: number } & FlowSize = {}): JsonObject {
  return flowText([
    { text: `${label}\n`, font: { size_pt: 8.5, weight: 800, color: "var(--fm-color-muted)", transform: "uppercase" } },
    ...runs
  ], { ...options, font: { family: "var(--fm-body-font)", size_pt: options.size_pt ?? 11, weight: 700 } });
}

export function flowWidget(ref: string, config: JsonObject, size: FlowSize = {}): JsonObject {
  return flowNode("widget", { props: { widget: ref, config } }, size);
}

export function flowSpacer(h: number): JsonObject {
  return flowNode("frame", { name: "Spacer", children: [] }, { h });
}

/** Side-by-side cells. Give a cell `grow` to share the row, or `w` to pin it. */
export function flowRow(children: JsonObject[], options: { gap?: number; align?: string; padding?: number[]; fill?: string } & FlowSize = {}): JsonObject {
  return flowNode("frame", {
    ...(options.fill ? { style: { fill: { type: "solid", color: options.fill } } } : {}),
    props: { flow: { direction: "row", gap: options.gap ?? 16, padding: options.padding ?? [0, 0, 0, 0], align: options.align ?? "start", wrap: false } },
    children
  }, options);
}

export function flowColumn(children: JsonObject[], options: { gap?: number; padding?: number[]; fill?: string; overflow?: string } & FlowSize = {}): JsonObject {
  return flowNode("frame", {
    ...(options.fill ? { style: { fill: { type: "solid", color: options.fill } } } : {}),
    props: { flow: { direction: "column", gap: options.gap ?? 8, padding: options.padding ?? [0, 0, 0, 0], align: "stretch", wrap: false }, ...(options.overflow ? { overflow: options.overflow } : {}) },
    children
  }, options);
}

/** Image bound to a media param; hidden while the param is empty. */
export function flowImage(bindPath: string, size: FlowSize, props: JsonObject = {}): JsonObject {
  const node = flowNode("image", { props: { fit: "cover", ...props } }, size);
  node.bind = {
    props: { "props.media": `{{${bindPath}}}` },
    if: `not_empty(coalesce(${bindPath}.media_id, ${bindPath}.url, ${bindPath}))`
  };
  return node;
}

/** Company logo from the resolved org scope; removed when the org has none. */
export function flowLogo(size: FlowSize = { w: 170, h: 36 }): JsonObject {
  const node = flowNode("image", { props: { fit: "contain", alt: "Company logo" } }, size);
  node.bind = { props: { "props.media": "{{org.logo_url}}" }, if: "not_empty(org.logo_url)" };
  return node;
}

export function flowComponent(component: string, input: JsonObject = {}): JsonObject {
  return flowNode("component_ref", { props: { component, input } });
}

export function flowRepeater(props: JsonObject): JsonObject {
  return flowNode("repeater", { props });
}

/** A component root: stretches to the width it is placed in. */
export function componentRow(children: JsonObject[], options: { gap?: number; padding?: number[]; fill?: string; align?: string } = {}): JsonObject {
  const node = flowRow(children, options);
  delete node.anchor;
  return node;
}

export function componentColumn(children: JsonObject[], options: { gap?: number; padding?: number[]; fill?: string } = {}): JsonObject {
  const node = flowColumn(children, options);
  delete node.anchor;
  return node;
}

/**
 * Append a page whose content is one paginating body region fitted to the
 * margins `theme` asks for on pages of `role`. The first call reuses the
 * document's initial empty page.
 */
export function addFlowPage(doc: JsonObject, theme: JsonObject, role: string, name: string, children: JsonObject[], options: { gap?: number; repeat?: JsonObject } = {}): JsonObject {
  const pages = (Array.isArray(doc.pages) ? doc.pages : []) as JsonObject[];
  const first = pages[0];
  const reuse = pages.length === 1 && !!first && !(first.children as unknown[] | undefined)?.length && !first.name;
  const page = reuse ? first : asObject(FMDocModel.createPage(role));
  page.role = role;
  page.name = name;
  if (options.repeat) page.repeat = options.repeat;
  const margins = FMDocModel.themePageMargins(theme, role);
  const box = FMDocModel.pageRegionBox("body", margins, FMDocModel.paperDimensions(doc));
  page.children = [
    FMDocModel.createNode("frame", {
      name: "Body",
      frame: { ...box, rotation: 0, z: 0, layout: "flow", constraints: { h: "stretch", v: "top" } },
      props: {
        page_region: "body",
        flow: { direction: "column", gap: options.gap ?? 10, padding: [0, 0, 0, 0], align: "stretch", wrap: false },
        overflow: "paginate"
      },
      children
    })
  ];
  if (!reuse) pages.push(page);
  doc.pages = pages;
  return page;
}
