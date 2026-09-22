import type { JsonObject } from "../platform/storage.js";
import { FMDocModel } from "./schemas.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function safeTabId(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

export type CustomerDocumentMode = "document" | "workflow" | "hybrid";

export type CustomerDocumentPresentation = {
  mode: CustomerDocumentMode;
  tab: { id: string; label: string; icon: string; order: number };
  workflow_cta: string;
  document_cta: string;
  auto_open: boolean;
};

/**
 * One presentation contract for every customer-facing document/workflow.
 * Templates provide defaults, instances may override them, and the portal only
 * consumes this normalized projection. Scope automations therefore decide
 * whether an issued item is a document, a page-like workflow, or both without
 * adding product-specific routes or tabs.
 */
export function normalizeCustomerDocumentPresentation(value: unknown, documentType = ""): CustomerDocumentPresentation {
  const source = asObject(value);
  const tab = asObject(source.tab || source.portal_tab);
  const type = cleanText(documentType).toLowerCase();
  const fallbackTab = type === "proposal"
    ? { id: "proposals", label: "Proposals", icon: "fa-file-signature", order: 50 }
    : type === "completion_certificate"
      ? { id: "sign_off", label: "Sign-Off", icon: "fa-flag-checkered", order: 70 }
      : { id: "documents", label: "Documents", icon: "fa-file-lines", order: 60 };
  const requestedMode = cleanText(source.mode).toLowerCase();
  const mode: CustomerDocumentMode = requestedMode === "workflow" || requestedMode === "hybrid" ? requestedMode : "document";
  return {
    mode,
    tab: {
      id: safeTabId(tab.id || source.tab_id) || fallbackTab.id,
      label: cleanText(tab.label || source.tab_label) || fallbackTab.label,
      icon: cleanText(tab.icon || source.tab_icon) || fallbackTab.icon,
      order: Number.isFinite(Number(tab.order ?? source.tab_order)) ? Number(tab.order ?? source.tab_order) : fallbackTab.order
    },
    workflow_cta: cleanText(source.workflow_cta || source.workflowCta) || "Review & continue",
    document_cta: cleanText(source.document_cta || source.documentCta) || "Review document",
    auto_open: source.auto_open === true || source.autoOpen === true
  };
}

export function customerPresentationFromDocument(document: JsonObject): CustomerDocumentPresentation {
  return normalizeCustomerDocumentPresentation(asObject(document.metadata).customer_presentation, cleanText(document.document_type));
}

export function documentSignatureRequirement(document: JsonObject): JsonObject {
  const defs = asObject(document.output_defs);
  const outputs = asObject(document.outputs);
  const requiredKeys = Object.entries(defs)
    .filter(([, value]) => {
      const def = asObject(value);
      return cleanText(def.type) === "signature" && def.required === true;
    })
    .map(([key]) => key);
  const pendingKeys = requiredKeys.filter((key) => {
    const value = outputs[key];
    return value === undefined || value === null || value === "" || (typeof value === "object" && !Array.isArray(value) && !Object.keys(asObject(value)).length);
  });
  return {
    required: requiredKeys.length > 0,
    required_count: requiredKeys.length,
    pending_count: pendingKeys.length,
    required_keys: requiredKeys,
    pending_keys: pendingKeys
  };
}

export type DocumentRequirementParty = "customer" | "company";

export type DocumentRequirementState = {
  key: string;
  type: string;
  party: DocumentRequirementParty;
  label: string;
  required: boolean;
  required_for_completion: boolean;
  satisfied: boolean;
};

function requirementParty(def: JsonObject): DocumentRequirementParty {
  const party = cleanText(def.party).toLowerCase();
  if (party === "company" || party === "internal") return "company";
  if (party === "customer") return "customer";
  return cleanText(def.signer) === "internal" ? "company" : "customer";
}

function requirementLabel(key: string, def: JsonObject): string {
  const label = cleanText(def.label);
  if (label) return label;
  const type = cleanText(def.type);
  if (type === "signature") return requirementParty(def) === "company" ? "Company signature" : "Customer signature";
  if (type === "payment") {
    const obligation = cleanText(def.obligation);
    return obligation ? `${obligation.charAt(0).toUpperCase()}${obligation.slice(1)} payment` : "Payment";
  }
  return key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * The UI-agnostic "what does this item still need" projection: every declared
 * output requirement with its type (signature/payment/…), owing party
 * (customer vs company), and satisfaction state — regardless of which surface
 * (portal document, portal workflow, on-device fill, uploaded paper contract)
 * will eventually record it. Timelines and tabs render from this instead of
 * re-deriving state per document type.
 */
export function documentRequirementsStatus(document: JsonObject): JsonObject {
  const defs = Object.fromEntries(Object.entries(asObject(document.output_defs)).filter(([, value]) => asObject(value).disabled !== true));
  const outputs = asObject(document.outputs);
  const status = cleanText(document.status);
  const requirements: DocumentRequirementState[] = Object.entries(defs).map(([key, value]) => {
    const def = asObject(value);
    return {
      key,
      type: cleanText(def.type) || "value",
      party: requirementParty(def),
      label: requirementLabel(key, def),
      required: def.required === true,
      required_for_completion: cleanText(def.required_for) === "completed",
      satisfied: Boolean(FMDocModel.outputValueSatisfies(def, outputs[key]))
    };
  });
  const gating = requirements.filter((req) => req.required || req.required_for_completion);
  const pending = gating.filter((req) => !req.satisfied);
  const waitingOn: string[] = [];
  if (pending.some((req) => req.type === "signature" && req.party === "customer")) waitingOn.push("customer_signature");
  if (pending.some((req) => req.type === "signature" && req.party === "company")) waitingOn.push("company_signature");
  if (pending.some((req) => req.type === "payment")) waitingOn.push("payment");
  if (pending.some((req) => req.type !== "signature" && req.type !== "payment")) waitingOn.push("customer_response");
  const terminal = ["void", "declined", "expired"].includes(status);
  return {
    requirements,
    pending_count: terminal ? 0 : pending.length,
    pending_keys: terminal ? [] : pending.map((req) => req.key),
    pending_customer_signatures: terminal ? 0 : pending.filter((req) => req.type === "signature" && req.party === "customer").length,
    pending_company_signatures: terminal ? 0 : pending.filter((req) => req.type === "signature" && req.party === "company").length,
    pending_payments: terminal ? 0 : pending.filter((req) => req.type === "payment").length,
    waiting_on: terminal ? [] : waitingOn,
    signed: FMDocModel.requiredOutputsSatisfied(defs, outputs),
    completed: FMDocModel.requiredOutputsSatisfied(defs, outputs) && FMDocModel.requiredOutputsSatisfied(defs, outputs, "completed")
  };
}
