import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

// 1M8-255: roof pitch as rise over 12 or degrees. 1M8-256: the summary page's totals card never overlaps.
const require = createRequire(import.meta.url);
const ReportUnits = require("../../libraries/report-units.js");

test("pitch notation: metric companies default to degrees, the setting wins, and other text is left alone", () => {
  const metric = ReportUnits.create({ measurement_system: "metric" });
  const imperial = ReportUnits.create({});
  assert.equal(metric.pitchNotation, "degrees");
  assert.equal(imperial.pitchNotation, "rise_12");
  assert.equal(metric.pitch("6/12"), "26.6°");
  assert.equal(metric.pitch("4 / 12"), "18.4°");
  assert.equal(metric.pitch(12), "45.0°");
  assert.equal(metric.pitch("6", 0), "27°", "diagram labels use whole degrees");
  assert.equal(metric.pitch("N/A"), "N/A");
  assert.equal(metric.pitch("Flat roof"), "Flat roof");
  assert.equal(imperial.pitch("6/12"), "6/12");
  assert.equal(imperial.pitch(4), "4/12");
  assert.equal(ReportUnits.create({ measurement_system: "metric", pitch_notation: "rise_12" }).pitch("6/12"), "6/12");
  assert.equal(ReportUnits.create({ measurement_system: "imperial", pitch_notation: "degrees" }).pitch("6/12"), "26.6°");
});

test("report preferences carry the pitch notation and default it from the measurement system", async () => {
  const { normalizeReportPreferences, defaultPitchNotation } = await import("../firstmeasure/report_preferences.js");
  assert.deepEqual(normalizeReportPreferences({}), { measurement_system: "imperial", report_language: "en-US", pitch_notation: "rise_12" });
  assert.equal(normalizeReportPreferences({ measurement_system: "metric" }).pitch_notation, "degrees");
  assert.equal(normalizeReportPreferences({ measurement_system: "metric", pitch_notation: "rise_12" }).pitch_notation, "rise_12");
  assert.equal(normalizeReportPreferences({ pitch_notation: "degrees" }).pitch_notation, "degrees");
  assert.throws(() => normalizeReportPreferences({ pitch_notation: "percent" }));
  assert.equal(defaultPitchNotation("metric"), "degrees");
  const { localizationSchema } = await import("../platform/localization/settings.js");
  assert.equal(localizationSchema.parse({ locale: "de-DE", measurement_system: "metric", pitch_notation: "degrees" }).pitch_notation, "degrees");
  assert.throws(() => localizationSchema.parse({ pitch_notation: "grade" }));
});

test("the XML export keeps pitch as rise over 12 and adds pitch_degrees", async () => {
  const { buildXmlExportPayload } = await import("../firstmeasure/xml.js");
  const stored = `<?xml version="1.0"?><STRUCTURES><ROOF id="R1"><POINTS><POINT id="P1" data="0,0,0"/><POINT id="P2" data="10,0,0"/><POINT id="P3" data="10,10,0"/></POINTS>`
    + `<LINES><LINE id="L1" path="P1,P2" type="EAVE"/><LINE id="L2" path="P2,P3" type="RAKE"/><LINE id="L3" path="P3,P1" type="RIDGE"/></LINES>`
    + `<FACES><FACE id="F1"><POLYGON id="PG1" path="L1,L2,L3" pitch="6" size="500"/></FACE></FACES></ROOF></STRUCTURES>`;
  const payload = buildXmlExportPayload({ format: "esx", manifest: { id: "p1", address: "1 Test St" } as any, storedRoofplanXml: stored });
  assert.match(payload.content, /pitch="6" pitch_degrees="26\.6"/);
  const generator = await readFile(new URL("../../measure/internal/editor_scripts/xml_generator.js", import.meta.url), "utf8");
  assert.match(generator, /pitch="\$\{pitch\}" pitch_degrees="\$\{\(Math\.atan\(pitch \/ 12\)/, "the report XML keeps pitch and adds pitch_degrees");
});

test("the PDF writes pitch in the project's notation", async () => {
  const source = await readFile(new URL("../../measure/internal/editor_scripts/pdf.js", import.meta.url), "utf8");
  const line = source.split("\n").find(l => l.startsWith("function pdfPitch("))!;
  for (const [preferences, expected] of [[{ measurement_system: "metric" }, "26.6°"], [{}, "6/12"]] as const) {
    const context = vm.createContext({ window: { ReportUnits: { current: () => ReportUnits.create(preferences) } } });
    vm.runInContext(line, context);
    assert.equal(vm.runInContext("pdfPitch('6/12')", context), expected);
  }
  // Every place the PDF prints a pitch goes through pdfPitch.
  for (const needle of ['{value1: pdfPitch(domPitch)}', 'doc.text(pdfPitch(p), pitchValX(i)', 'pdfPitch(structureMetrics.predominantPitch', 'String(pdfPitch(r.pitch))', "pdfPitch(String(lbl.pitchText ?? lbl.text ?? ''), 0)"]) {
    assert.ok(source.includes(needle), needle);
  }
});

test("summary totals card: labels never reach their values, in any language (1M8-256)", async () => {
  const { jsPDF } = await import("jspdf");
  const fonts = new URL("../../fonts/", import.meta.url);
  const doc = new jsPDF({ unit: "mm", format: "letter" });
  doc.addFileToVFS("Montserrat-Regular.ttf", (await readFile(new URL("Montserrat-Regular.ttf", fonts))).toString("base64"));
  doc.addFont("Montserrat-Regular.ttf", "Montserrat", "normal");
  doc.addFileToVFS("Montserrat-Bold.ttf", (await readFile(new URL("Montserrat-Bold.ttf", fonts))).toString("base64"));
  doc.addFont("Montserrat-Bold.ttf", "Montserrat", "bold");
  const source = await readFile(new URL("../../measure/internal/editor_scripts/pdf.js", import.meta.url), "utf8");
  const start = source.indexOf("function drawPdfStatRow(");
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, start + source.slice(start).search(/\r?\n\}\r?\n/) + 3), context);
  const draw = context.drawPdfStatRow as (doc: any, label: string, value: string, x: number, y: number, width: number, size?: number) => { lines: string[]; labelSize: number; labelW: number; valueW: number };
  // The card in Ben's screenshot is the portrait summary page's 40 mm totals card.
  const x = 150, width = 40;
  const rows: Array<[string, string]> = [
    ["Headwall Flashing", "32.66 m"], ["Sidewall Flashing", "35.22 m"], ["Roof Area", "1,035.05 m²"], ["Pitch", "18.4°"],
    ["Solapa de muro frontal", "32,66 m"], ["Wandanschluss-Abdeckblech", "35,22 m"], ["Solin de mur latéral", "35,22 m"],
    ["Chimney Back Pan", "1,234 ft"], ["Przyścienne obróbki blacharskie", "35,22 m"]
  ];
  let y = 40;
  for (const [label, value] of rows) {
    doc.setFont("Montserrat", "bold"); doc.setFontSize(9);
    const before = doc.getTextWidth(label);
    const laid = draw(doc, label, value, x, y, width, 9);
    doc.setFont("Montserrat", "bold"); doc.setFontSize(laid.labelSize);
    const labelRight = x + Math.max(...laid.lines.map(line => doc.getTextWidth(line)));
    doc.setFont("Montserrat", "normal"); doc.setFontSize(9);
    const valueLeft = x + width - doc.getTextWidth(value);
    assert.ok(labelRight < valueLeft, `${label} ends at ${labelRight.toFixed(1)} mm, before ${value} at ${valueLeft.toFixed(1)} mm`);
    assert.ok(laid.lines.length <= 2, `${label} fits in two lines`);
    if (label === "Headwall Flashing") assert.ok(x + before > valueLeft, "at 9 pt the old layout overlapped, as in the screenshot");
    y += 8;
  }
  // The page renders.
  assert.ok(doc.output("arraybuffer").byteLength > 1000);
});
