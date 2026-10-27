// 1M8-233: roof-only PDFs carried a "North, South, East, West" 3D Elevations page whenever the
// technician had uploaded a Quad screenshot. Production sets no disable_quad_views switch and
// organizations' report settings leave it unset, so the page appeared for some technicians only,
// with whatever picture they uploaded (broken, one view four times, another property).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../../../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
function functions(file, names) {
  const code = read(file), tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true), found = [];
  (function visit(n) { if (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) found.push(n.getText(tree)); ts.forEachChild(n, visit); })(tree);
  assert.equal(found.length, names.length, `${file}: ${names.join(', ')}`);
  return found.join('\n');
}

// What a production editor sees for an affected order (2122 S Riverside Rd, 10055 Bishops Gate Blvd).
function productionWindow() {
  const elements = { btnQuadView: { style: {}, hidden: false }, step4: { style: {}, hidden: false } };
  const quadImage = 'data:image/png;base64,UPLOADED_SCREENSHOT';
  return {
    elements,
    quadImage,
    window: {
      FIRSTMEASURE_REPORT_SETTINGS: [],
      FIRSTMEASURE_DISABLE_QUAD_VIEWS: false,
      PORTAL_CFG: {},
      projectOrganization: { id: 'ed7788597b0aef0e8e81d694', report_settings: { general: { nfva_ratio: 300 }, customer: { page_elevations: true } } },
      quadViewCroppedImage: quadImage
    },
    document: { getElementById: (id) => elements[id] || null }
  };
}

function load(file, names, extra = {}) {
  const env = productionWindow();
  const context = { ...env, qaImageBundle: { organization: env.window.projectOrganization }, ...extra };
  vm.createContext(context);
  vm.runInContext(functions(file, names), context);
  return context;
}

test('quad views are off for an organization whose report settings never mention them', () => {
  assert.equal(load('public/measure/internal/editor_scripts/pdf.js', ['firstMeasurePdfQuadViewsDisabled']).firstMeasurePdfQuadViewsDisabled(), true);
  assert.equal(load('public/measure/internal/editor_scripts/report.js', ['areReportQuadViewsDisabled']).areReportQuadViewsDisabled(), true);
  assert.equal(load('public/measure/internal/editor_scripts/main.js', ['firstMeasureAreQuadViewsDisabled']).firstMeasureAreQuadViewsDisabled(), true);
  assert.equal(load('public/measure/internal/portal_scripts/qa.js', ['areQaQuadViewsDisabled']).areQaQuadViewsDisabled(), true);
});

test('opening a project hides the Quad tool and drops an uploaded quad screenshot', () => {
  const context = load('public/measure/internal/editor_scripts/main.js', ['firstMeasureAreQuadViewsDisabled', 'firstMeasureApplyQuadViewReportToggle']);
  context.firstMeasureApplyQuadViewReportToggle();
  assert.equal(context.window.quadViewCroppedImage, null);
  assert.equal(context.elements.btnQuadView.hidden, true);
  assert.equal(context.elements.step4.hidden, true);
});

test('a re-issue does not bring back the quad image saved in an earlier pdf_state', () => {
  const context = load('public/measure/internal/editor_scripts/report.js', ['areReportQuadViewsDisabled', 'cloneReportJson', 'mergeReportConfigStateIntoLatestState']);
  const saved = { quadImage: context.quadImage, elevationSettings: { include: true } };
  const merged = context.mergeReportConfigStateIntoLatestState({ quadImage: null }, saved);
  assert.equal(merged.quadImage, null);
  assert.equal(merged.elevationSettings.include, false);
});

test('the PDF draws the Elevations page only from a quad image, which retired quad views never allow', () => {
  const pdf = read('public/measure/internal/editor_scripts/pdf.js');
  assert.match(pdf, /const hasQuadImage = !firstMeasurePdfQuadViewsDisabled\(\) && /);
  assert.match(pdf, /if \(s\.page_elevations && includeElev && !hasExterior\) \{\r?\n\s+beginReportPage\(roofTitle\(pdfLabel\("Roof Elevations"\), "3D Elevations"\)\);/);
  assert.match(pdf, /const includeElev = hasQuadImage && /);
  assert.match(pdf, /quadImage: firstMeasurePdfQuadViewsDisabled\(\) \? null : /);
});
