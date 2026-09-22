import assert from "node:assert/strict";
import test from "node:test";

import { PDFDocument } from "pdf-lib";

import { renderProposalPdf } from "../proposals/pdf.js";

const formats = [
  { key: undefined, name: "default Letter", width: 612, height: 792 },
  { key: "legal", name: "Legal", width: 612, height: 1008 },
  { key: "a4", name: "A4", width: (210 / 25.4) * 72, height: (297 / 25.4) * 72 }
];

test("proposal fallback PDFs honor Letter, Legal, and A4 page dimensions", async () => {
  for (const format of formats) {
    const rendered = await renderProposalPdf({
      proposal: {
        title: `${format.name} proposal`,
        editable: {
          paper_size: format.key,
          pages: [{ kind: "summary", title: "Page", body: "Dimension check" }]
        }
      }
    });
    const document = await PDFDocument.load(rendered.bytes);
    const page = document.getPage(0);
    const size = page.getSize();
    assert.ok(Math.abs(size.width - format.width) < 0.01, `${format.name} width should match`);
    assert.ok(Math.abs(size.height - format.height) < 0.01, `${format.name} height should match`);
  }
});
