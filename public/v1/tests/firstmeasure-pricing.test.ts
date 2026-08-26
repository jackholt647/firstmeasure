import assert from "node:assert/strict";
import test from "node:test";

import {
  firstMeasureReportAmount,
  firstMeasureReportCharge,
  firstMeasureReportExpediteDiscount
} from "../firstmeasure/pricing.js";
import { firstMeasurePublicReportAmount } from "../public-firstmeasure/billing.js";

const pins = Array.from({ length: 3 }, (_, index) => ({ lat: 35 + index, lng: -120 - index }));

test("portal and public API pricing use one canonical report calculator", () => {
  const cases = [
    { project_type: "residential", report_mode: "full", pins },
    { project_type: "residential", report_mode: "both", include_gutter_measurements: true, include_weather_report: true, pins },
    { project_type: "commercial", report_mode: "instant", include_gutter_measurements: true, include_weather_report: true, pins },
    { project_type: "multifamily", report_mode: "full", report_expedite_option: "rush_1_3", pins }
  ];
  for (const input of cases) {
    assert.equal(firstMeasurePublicReportAmount(input), firstMeasureReportAmount(input));
  }
});

test("gutter pricing matches the portal: flat residential add-on and no non-residential add-on", () => {
  const residentialWithout = firstMeasureReportAmount({ project_type: "residential", pins });
  const residentialWith = firstMeasureReportAmount({ project_type: "residential", pins, include_gutter_measurements: true });
  assert.equal(residentialWith - residentialWithout, 2);

  const commercialWithout = firstMeasureReportAmount({ project_type: "commercial", pins });
  const commercialWith = firstMeasureReportAmount({ project_type: "commercial", pins, include_gutter_measurements: true });
  assert.equal(commercialWith, commercialWithout);
});

test("free expedite charge calculation is derived from the same gross price", () => {
  const input = { project_type: "commercial", report_expedite_option: "rush_under_1", pins };
  const gross = firstMeasureReportAmount(input);
  const discount = firstMeasureReportExpediteDiscount(input);
  const charge = firstMeasureReportCharge({ ...input, free_expedite_uses: 1 });
  assert.equal(charge.gross_amount, gross);
  assert.equal(charge.free_expedite_discount, discount);
  assert.equal(charge.amount, Math.round(Math.max(0.01, gross - discount) * 100) / 100);
});
