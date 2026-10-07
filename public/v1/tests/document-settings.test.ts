import assert from "node:assert/strict";
import test from "node:test";
import { documentCustomerComplete, documentDeliveryDefaults } from "../documents/settings.js";

test("document defaults preserve legacy values but explicit new false/empty settings win", () => {
  const legacy = { send_include_pdf: false, send_include_portal: false, completion_message: "Old message" };
  assert.deepEqual(documentDeliveryDefaults({}, legacy), legacy);
  assert.deepEqual(documentDeliveryDefaults({ send_include_pdf: true, completion_message: "" }, legacy), {
    send_include_pdf: true, send_include_portal: false, completion_message: ""
  });
});

test("completion waits for signing and this snapshot's initial payments, not unrelated final balances", () => {
  const snapshot = { id: "s1", output_defs: {} };
  const document = { id: "d1", status: "signed", delivery: { current_snapshot_id: "s1" } };
  const deposit = { source: { type: "document", id: "d1", snapshot_id: "s1" }, kind: "deposit", amount_cents: 100, allocated_cents: 0 };
  assert.equal(documentCustomerComplete(document, snapshot, { status: "open" }, []), false);
  assert.equal(documentCustomerComplete(document, snapshot, { status: "completed" }, [deposit]), false);
  assert.equal(documentCustomerComplete(document, snapshot, { status: "completed" }, [{ ...deposit, allocated_cents: 100 }]), true);
  assert.equal(documentCustomerComplete(document, snapshot, { status: "completed" }, [{ ...deposit, kind: "final" }]), true);
  assert.equal(documentCustomerComplete(document, snapshot, { status: "completed" }, [{ ...deposit, source: { type: "document", id: "other", snapshot_id: "s1" } }]), true);
  assert.equal(documentCustomerComplete(document, { ...snapshot, id: "old" }, { status: "completed" }, []), false);
  assert.equal(documentCustomerComplete({ ...document, status: "canceled" }, snapshot, { status: "completed" }, []), false);
  const gated = { ...snapshot, output_defs: { payment: { type: "payment", required_for: "completed" } } };
  assert.equal(documentCustomerComplete(document, gated, { status: "completed" }, []), false);
  assert.equal(documentCustomerComplete({ ...document, status: "completed" }, gated, { status: "completed" }, []), true);
});
