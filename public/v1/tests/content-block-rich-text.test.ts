import assert from "node:assert/strict";
import test from "node:test";
import { FMDocModel } from "../documents/schemas.js";
import { roofingEstimateDefinition } from "../signup-sandbox/roofing-documents.js";
import { mediaVariantEntry } from "../platform/media_variants.js";

type Node = { type?: string; props?: { blocks?: Array<{ type?: string; list_style?: string; runs?: Array<{ text?: string; weight?: number }> }>; media?: { url?: string }; rows?: unknown[] }; children?: Node[] };

function walk(nodes: Node[], visit: (node: Node) => void) {
  for (const node of nodes || []) { visit(node); walk(node.children || [], visit); }
}

test("a content block's Markdown body resolves to formatted text, lists and tables, with its GIF", () => {
  const definition = roofingEstimateDefinition("detailed", { roof: 450, gutter: 12 }) as Record<string, unknown>;
  const resolved = FMDocModel.resolveBindings(definition, {
    params: {
      content_blocks: [
        { id: "cb1", title: "Your roof", body: "**Granule loss** on the south face\n- Lifted shingles\n- Soft decking\n\n| Area | Finding |\n| --- | --- |\n| Ridge | Cracked caps |\n<!--fm-table-widths:120,200-->", layout: "auto", display: "inline",
          gif: { id: "g1", url: "https://media1.giphy.com/media/abc/200w.gif", title: "Roof", width: 200, height: 150 } },
        { id: "cb2", title: "Older", body: "A plain description\nfrom before rich text.", layout: "text_only", display: "inline" }
      ]
    }
  }) as { pages: Array<{ children: Node[] }> };
  const blocks: Array<{ type?: string; list_style?: string; text: string; bold: boolean }> = [];
  const images: string[] = [];
  let tables = 0;
  let text = "";
  for (const page of resolved.pages) walk(page.children, (node) => {
    if (node.type === "text") for (const block of node.props?.blocks || []) {
      const value = (block.runs || []).map((run) => String(run.text ?? "")).join("");
      text += value + "\n";
      blocks.push({ type: block.type, list_style: block.list_style, text: value, bold: (block.runs || []).some((run) => Number(run.weight) >= 700) });
    }
    if (node.type === "table") tables += 1;
    if (node.type === "image" && node.props?.media?.url) images.push(String(node.props.media.url));
  });
  assert.ok(blocks.some((block) => block.text.startsWith("Granule loss") && block.bold), "bold run");
  assert.deepEqual(blocks.filter((block) => block.type === "list_item").map((block) => block.text), ["Lifted shingles", "Soft decking"]);
  assert.equal(tables, 1, "the Markdown table is a table node");
  assert.ok(images.includes("https://media1.giphy.com/media/abc/200w.gif"), "the GIF shows on the document");
  assert.match(text, /Powered by GIPHY/);
  assert.match(text, /A plain description\nfrom before rich text\./, "plain text still reads as it did");
  assert.doesNotMatch(text, /\*\*|fm-table-widths|\| --- \|/);
});

test("a thumbnail request for an image that never got one serves the original", () => {
  const original = { path: "original.png", content_type: "image/png" };
  assert.equal(mediaVariantEntry({ variants: { original } }, "thumb_320"), original);
  assert.equal(mediaVariantEntry({ variants: { original, thumb_320: { path: "t.webp" } } }, "thumb_320").path, "t.webp");
  assert.equal(mediaVariantEntry({ variants: { original } }, "display"), original);
  assert.equal(mediaVariantEntry({ variants: { original, thumb_320: { path: "t.webp" } } }, "thumb_320_markup").path, "t.webp");
  assert.deepEqual(mediaVariantEntry({ variants: { original: { path: "clip.mp4", content_type: "video/mp4" } } }, "thumb_320"), {}, "a video without a poster stays not found");
  assert.deepEqual(mediaVariantEntry({ variants: { original } }, "display_2400_extra"), {});
});
