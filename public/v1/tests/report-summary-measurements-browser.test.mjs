// 1M8-254: the portal's Roof Report Summary showed the same tiny measurements (10 ft of eave) for every order since
// October 20, and none at all for older ones; the CSV button downloads that list. Chrome runs the real summary code from
// measurements/project.js:
// - every order's manifest carries language_snapshot.report_dictionary, whose report labels ("Eave Drip Edge (10 ft)")
//   were read as line lengths;
// - a customer cannot read the project measurement dataset (403), and that refusal stopped the report's own XML from
//   ever being read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const source = await readFile(new URL('../../libraries/apps/measurements/project.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `project.js has ${name}`);
  let i = source.indexOf('{', source.indexOf(')', start)), depth = 0;
  for (; i < source.length; i++) { if (source[i] === '{') depth++; else if (source[i] === '}' && --depth === 0) break; }
  return source.slice(start, i + 1);
}
const constant = name => {
  const start = source.indexOf(`  const ${name} = `);
  return start < 0 ? '' : source.slice(start, source.indexOf(';', source.indexOf('])', start)) + 1);
};
const SUMMARY = [constant('REPORT_SUMMARY_NON_MEASUREMENT_KEYS'), ...['numericValue', 'plainObject', 'readPath', 'firstFinitePath', 'reportLineType',
  'reportLineMetricLabel', 'reportLineLength', 'reportDirectLength', 'reportObstacleType', 'reportObstacleLabel', 'reportPointKey', 'reportLinePoints',
  'reportDimensionLabel', 'reportObstacleDimension', 'collectReportObstacleRows', 'collectReportLineTotals', 'formatSummaryNumber', 'finiteMetricValue',
  'calculateReportSummarySuggestedWaste', 'reportSummaryWastePercent', 'reportSummaryWithWallRows', 'reportSummaryMetricRows', 'reportSummarySources',
  'xmlAttr', 'xmlPointCoordinates', 'distanceBetweenPoints', 'reportSummaryMetricsFromXml', 'reportSummaryMetricCacheKey',
  'reportSummaryRowsFromRoofMeasurements', 'reportSummaryWallRows', 'loadReportSummaryMetricsFromXml']
  .filter(name => name !== 'reportDirectLength' || source.includes('  function reportDirectLength('))
  .filter(name => name !== 'calculateReportSummarySuggestedWaste' || source.includes('  function calculateReportSummarySuggestedWaste('))
  .map(fn)].join('\n');

// An order completed since October 20, as production stores it: report labels in the language snapshot, history events.
const MANIFEST = {
  id: '0247577fcabdcb97db7c4c8c715b4e39', status: 'completed', project_type: 'residential',
  work_history: [{ event: 'claimed_new' }, { event: 'submitted_for_qa' }, { event: 'qa_approved' }],
  email_events: [{ type: 'report_ready', at: '2026-10-28T21:15:51Z' }],
  language_snapshot: { locale: 'en-US', report_dictionary: {
    Eave: 'Eave', 'Eaves:': 'Eaves:', Ridge: 'Ridge', 'Step Flashing (5x7)': 'Step Flashing (5x7)', 'Eave Drip Edge (10 ft)': 'Eave Drip Edge (10 ft)',
    'Rake Drip Edge (10 ft)': 'Rake Drip Edge (10 ft)', 'Valley Metal W (10 ft)': 'Valley Metal W (10 ft)', 'Counter Flashing (10 ft)': 'Counter Flashing (10 ft)',
    'Headwall Flashing (10 ft)': 'Headwall Flashing (10 ft)', 'Ridge Vent (4 ft sections)': 'Ridge Vent (4 ft sections)', 'Chimney Counter Flash (10 ft)': 'Chimney Counter Flash (10 ft)'
  } }
};
// model_data.xml in production's format: lines with paths over points (feet), faces with polygon size and pitch.
const xml = (eave, ridge, size) => `<?xml version="1.0" encoding="UTF-8"?><DATA_EXPORT><STRUCTURES><ROOF id="ROOF1">
  <FACES><FACE id="F1" type="ROOF"><POLYGON id="P1" path="L1,L2" pitch="6" size="${size}"/></FACE><FACE id="F2" type="ROOF"><POLYGON id="P2" path="L1,L2" pitch="4" size="${size / 2}"/></FACE></FACES>
  <LINES><LINE id="L1" path="C1,C2" type="EAVE"/><LINE id="L2" path="C3,C4" type="RIDGE"/></LINES>
  <POINTS><POINT id="C1" data="0,0,0"/><POINT id="C2" data="${eave},0,0"/><POINT id="C3" data="0,10,8"/><POINT id="C4" data="${ridge},10,8"/></POINTS>
</ROOF></STRUCTURES></DATA_EXPORT>`;
const XML = { a: xml(120, 40, 1000), b: xml(64, 22, 600) };

async function summary(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://portal.test/**', route => {
    const url = new URL(route.request().url());
    const project = url.pathname.split('/')[4];
    if (url.pathname.endsWith('/artifacts/model_data.xml') && XML[project]) return route.fulfill({ contentType: 'application/xml', body: XML[project] });
    if (url.pathname.includes('/publication/')) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  });
  await page.goto('https://portal.test/portal/');
  await page.addScriptTag({ content: `
    let activeBaseProject = {}, reportOrderState = {}, manifest = {};
    let activePreviewTab = '', activeMeasurementTab = '';
    const measurementSummaryMetricCache = new Map(), measurementSummaryMetricLoads = new Set();
    const reportOrderMeasurement = () => ({ raw: { manifest } });
    const reportOrderManifest = () => manifest;
    const reportSummaryIsFullHouse = () => false;
    const renderMeasurementsPanel = () => {};
    const fmUrl = path => 'https://portal.test/v1/firstmeasure/' + path;
    ${SUMMARY}
    window.rowsFor = (value) => { manifest = value; return reportSummaryMetricRows([]); };
    // The shared loader as customers get it: the measurement dataset answers 403 and the load rejects.
    window.FirstMeasureAPI = { roofMeasurements: { load: () => fetch('https://portal.test/v1/publication/organizations/org_x/projects/project_x/measurements')
      .then(response => { if (!response.ok) { const error = new Error('forbidden'); error.status = response.status; throw error; } return response.json(); }) } };
    window.loadSummary = async (id) => {
      manifest = { ...${JSON.stringify(MANIFEST)}, id };
      loadReportSummaryMetricsFromXml('https://portal.test/v1/firstmeasure/projects/' + id + '/artifacts/model_data.xml', id);
      for (let i = 0; i < 50 && !measurementSummaryMetricCache.has(id); i++) await new Promise(resolve => setTimeout(resolve, 20));
      return reportSummaryMetricRows(measurementSummaryMetricCache.get(id) || []);
    };
  ` });
  return { page, errors };
}

const row = (rows, label) => rows.find(item => item.label === label)?.value;

test('1M8-254: report labels in the order\'s language snapshot are not read as measurements', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await summary(browser);
    const rows = await page.evaluate(manifest => window.rowsFor(manifest), MANIFEST);
    assert.deepEqual(rows, [], JSON.stringify(rows));
    // A measurement stored on the record is still read.
    const stored = await page.evaluate(manifest => window.rowsFor({ ...manifest, measurements: { eaves_lf: '132.5 ft', ridge: 41 } }), MANIFEST);
    assert.equal(row(stored, 'Eaves'), '133', JSON.stringify(stored));
    assert.equal(row(stored, 'Ridges'), '41', JSON.stringify(stored));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('1M8-254: when the measurement dataset is refused, each report shows its own XML measurements', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const { page, errors } = await summary(browser);
    const a = await page.evaluate(() => window.loadSummary('a'));
    const b = await page.evaluate(() => window.loadSummary('b'));
    assert.equal(row(a, 'Eaves'), '120', JSON.stringify(a));
    assert.equal(row(a, 'Ridges'), '40', JSON.stringify(a));
    assert.equal(row(a, 'Roof area'), '1,500', JSON.stringify(a));
    assert.equal(row(b, 'Eaves'), '64', JSON.stringify(b));
    assert.equal(row(b, 'Ridges'), '22', JSON.stringify(b));
    assert.equal(row(b, 'Roof area'), '900', JSON.stringify(b));
    assert.ok(!a.some(item => item.value === '10' && item.label !== 'Suggested waste'), JSON.stringify(a));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
