import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { stripeCreditReceiptDescription } from "../payments/stripe_receipt.js";

test("credit purchases use the requested Stripe receipt description", () => {
  assert.equal(
    stripeCreditReceiptDescription(250),
    "$250 in credits added to your FirstMate balance. Roof reports come out of this balance; you won't be charged again until you reload."
  );
  assert.equal(
    stripeCreditReceiptDescription(312.5),
    "$312.50 in credits added to your FirstMate balance. Roof reports come out of this balance; you won't be charged again until you reload."
  );
});

test("checkout and both automatic top-up paths send the description to Stripe", async () => {
  const [platformSource, publicApiSource] = await Promise.all([
    readFile(path.resolve(process.cwd(), "platform/api.ts"), "utf8"),
    readFile(path.resolve(process.cwd(), "public-firstmeasure/billing.ts"), "utf8")
  ]);

  assert.match(platformSource, /"payment_intent_data\[description\]": stripeCreditReceiptDescription\(totalCredit\)/);
  assert.match(platformSource, /description: stripeCreditReceiptDescription\(topup\)/);
  assert.match(publicApiSource, /description: stripeCreditReceiptDescription\(topup\)/);
});
