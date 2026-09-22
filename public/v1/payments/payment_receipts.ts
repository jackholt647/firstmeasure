import { renderTemplatedArtifact } from "../documents/artifacts.js";
import type { JsonObject } from "../platform/storage.js";
import { readPayment } from "./storage.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export async function renderPaymentReceiptPdf(orgId: string, paymentId: string, actorUserId = "system_payment_receipt") {
  const payment = await readPayment(orgId, paymentId);
  const suffix = cleanText(payment.id).slice(-10).toUpperCase() || "PAYMENT";
  const receiptNumber = `RCPT-${suffix}`;
  const method = asObject(payment.method);
  const rendered = await renderTemplatedArtifact({
    orgId,
    documentId: `doc_payment_receipt_${cleanText(payment.id)}`,
    documentType: "payment_receipt",
    templateId: "tpl_payment_receipt_default",
    projectId: cleanText(payment.project_id),
    branchId: cleanText(payment.branch_id || "default"),
    actorUserId,
    title: `Payment Receipt ${receiptNumber}`,
    fileName: `payment-receipt-${suffix.toLowerCase()}.pdf`,
    params: {
      customer: asObject(payment.contact_ref),
      receipt_number: receiptNumber,
      payment_date: cleanText(payment.settled_at || payment.received_at || payment.created_at),
      amount_cents: Math.max(0, Math.round(Number(payment.amount_cents || 0))),
      payment_method: cleanText(method.label || method.type || payment.kind || "Payment"),
      status: cleanText(payment.status || "Paid").replace(/_/g, " ")
    },
    metadata: { source_system: "payments", source_payment_id: cleanText(payment.id) }
  });
  return { ...rendered, contentType: "application/pdf", payment };
}
