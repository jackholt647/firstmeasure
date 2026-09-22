import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const publicRoot = path.resolve(import.meta.dirname, "..", "..");
const proposalSource = await readFile(path.join(publicRoot, "libraries/apps/proposals/project.js"), "utf8");
const proposalStyles = await readFile(path.join(publicRoot, "libraries/apps/project-request/app.js"), "utf8");
const checklistSource = await readFile(path.join(publicRoot, "libraries/apps/checklists/app.js"), "utf8");
const portalShell = await readFile(path.join(publicRoot, "portal/index.php"), "utf8");
const customerPortalSource = await readFile(path.join(publicRoot, "customer_portal/customer_portal.js"), "utf8");
const pdfSource = await readFile(path.join(publicRoot, "v1/proposals/pdf.ts"), "utf8");

test("proposal editor exposes and persists all supported paper sizes", () => {
  assert.match(proposalSource, /letter:[\s\S]*?legal:[\s\S]*?a4:/);
  assert.match(proposalSource, /function normalizeProposalPaperSize[\s\S]*?return 'letter';/);
  assert.match(proposalSource, /data-proposal-paper-size/);
  assert.match(proposalSource, /currentProposal\.paper_size = paperSize/);
  assert.match(proposalSource, /proposalPageCssVariables\(proposal\)/);
  assert.match(proposalSource, /r-proposal-type-paper-row[\s\S]*?data-proposal-font[\s\S]*?data-proposal-paper-size/);
});

test("portal shell exposes visible draggable scrollbars everywhere", () => {
  assert.match(portalShell, /--fm-scrollbar-size:12px/);
  assert.match(portalShell, /\*::\-webkit-scrollbar\{[^}]*width:var\(--fm-scrollbar-size\)/);
  assert.match(portalShell, /@supports not selector\(::\-webkit-scrollbar\)\{[\s\S]*?scrollbar-color:/);
  assert.match(portalShell, /\*::\-webkit-scrollbar-button\{[^}]*display:none;[^}]*width:0;[^}]*height:0/);
  assert.match(portalShell, /\*::\-webkit-scrollbar-thumb\{[^}]*min-height:44px;[^}]*background-color:var\(--fm-scrollbar-thumb\);[^}]*box-shadow:/);
  assert.match(portalShell, /\*::\-webkit-scrollbar-thumb:hover\{[^}]*background-color:var\(--fm-scrollbar-thumb-hover\);[^}]*box-shadow:/);
});

test("proposal editor rail reserves clearance beside the shared scrollbar", () => {
  assert.match(proposalStyles, /\.r-proposal-rail-scroll\{[^}]*padding-right:var\(--fm-scrollbar-content-gap,10px\);[^}]*scrollbar-gutter:stable/);
  assert.match(proposalStyles, /\.r-proposal-type-paper-row\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
});

test("shared project, scope builder, and checklist scrollers reserve content clearance", () => {
  assert.match(proposalStyles, /\.r-scroll\{[^}]*padding-right:var\(--fm-scrollbar-content-gap,10px\);[^}]*scrollbar-gutter:stable/);
  assert.match(proposalSource, /\.r-builder-sidebar-shell>\.r-builder-active-scope\{[^}]*padding-right:calc\(12px \+ var\(--fm-scrollbar-content-gap,10px\)\);[^}]*scrollbar-gutter:stable/);
  assert.match(proposalSource, /\.r-builder-sidebar-list\{[^}]*padding-right:var\(--fm-scrollbar-content-gap,10px\);[^}]*scrollbar-gutter:stable/);
  assert.match(checklistSource, /\.fmcl-content\{[^}]*scrollbar-gutter:stable;[^}]*padding-right:var\(--fm-scrollbar-content-gap,10px\)/);
});

test("proposal pagination derives each content budget from the selected page height", () => {
  const pricing = proposalSource.match(/function proposalPricingMetrics[\s\S]*?function proposalPricingCapacity/)?.[0] || "";
  const media = proposalSource.match(/function proposalMediaPageLimit[\s\S]*?function proposalMediaBlockHeight/)?.[0] || "";
  const finePrint = proposalSource.match(/function proposalSplitFinePrintSections[\s\S]*?function proposalSectionPageCount/)?.[0] || "";
  assert.match(pricing, /proposalPageHeightDelta/);
  assert.match(media, /proposalPageHeightDelta/);
  assert.match(finePrint, /proposalPageHeightDelta/);
});

test("print and customer portal renderers preserve the proposal paper format", () => {
  assert.match(proposalSource, /@page\{size:\$\{paper\.cssWidth\} \$\{paper\.cssHeight\}/);
  assert.match(pdfSource, /width: paper\.cssWidth/);
  assert.match(pdfSource, /height: paper\.cssHeight/);
  assert.match(customerPortalSource, /proposalPaperDimensions/);
  assert.match(customerPortalSource, /--proposal-page-base-height:\$\{paper\.heightPx\.toFixed\(3\)\}px!important/);
});
