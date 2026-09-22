import { forbidden } from "../platform/errors.js";
import { effectiveCapabilities } from "../platform/capabilities.js";
import type { JsonObject } from "../platform/storage.js";

export const DOCUMENT_CAPABILITIES = {
  app: "platform.documents",
  studio: "documents.templates_studio",
  workflowAuthoring: "documents.workflow_authoring",
  themeAuthoring: "documents.theme_authoring",
  advancedDefinitionEditing: "documents.advanced_definition_editing",
  customFolders: "documents.custom_folders",
  designer: "documents.designer_profile",
  esign: "documents.esign",
  payments: "documents.payments",
  portalPayments: "customer_portal.payments",
  agent: "documents.agent",
  ingestion: "documents.ingestion",
  enabledTypes: "documents.enabled_types"
} as const;

export type DocumentCapabilityState = {
  effectiveByKey: Record<string, boolean>;
  enabledTypes: Set<string> | null;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

export async function documentCapabilityState(orgId: string): Promise<DocumentCapabilityState> {
  const resolution = await effectiveCapabilities(orgId);
  const configuredTypes = cleanText(resolution.values[DOCUMENT_CAPABILITIES.enabledTypes]);
  const enabledTypes = configuredTypes
    ? new Set(configuredTypes.split(",").map(cleanText).filter(Boolean))
    : null;
  return { effectiveByKey: resolution.effectiveByKey, enabledTypes };
}

export function documentCapabilityEnabled(state: DocumentCapabilityState, key: string) {
  return state.effectiveByKey[key] === true;
}

/** Public document payment controls honor both the document feature and the
 * customer-portal collection feature. Internal document workflows only need
 * the document capability, so this projection is deliberately surface-specific. */
export function publicDocumentCapabilityState(state: DocumentCapabilityState): DocumentCapabilityState {
  return {
    ...state,
    effectiveByKey: {
      ...state.effectiveByKey,
      [DOCUMENT_CAPABILITIES.payments]: documentCapabilityEnabled(state, DOCUMENT_CAPABILITIES.payments)
        && documentCapabilityEnabled(state, DOCUMENT_CAPABILITIES.portalPayments)
    }
  };
}

export function documentTypeEnabled(state: DocumentCapabilityState, documentType: unknown) {
  const type = cleanText(documentType).toLowerCase();
  return !state.enabledTypes || state.enabledTypes.has(type);
}

export function requireDocumentTypeEnabled(state: DocumentCapabilityState, documentType: unknown) {
  const type = cleanText(documentType).toLowerCase();
  if (documentTypeEnabled(state, type)) return;
  throw forbidden("document_type_disabled", `The '${type}' document type is disabled for this organization.`);
}

export function documentOutputCapability(definition: unknown): string | null {
  const type = cleanText(asObject(definition).type).toLowerCase();
  if (type === "signature") return DOCUMENT_CAPABILITIES.esign;
  if (type === "payment") return DOCUMENT_CAPABILITIES.payments;
  return null;
}

export function workflowItemCapability(item: unknown): string | null {
  const source = asObject(item);
  const kind = cleanText(source.kind || source.id).toLowerCase();
  if (kind === "signature") return DOCUMENT_CAPABILITIES.esign;
  if (kind === "payment") return DOCUMENT_CAPABILITIES.payments;
  return null;
}

export function widgetCapability(widgetId: unknown): string | null {
  const id = cleanText(widgetId).toLowerCase().split("@")[0] || "";
  if (id === "doc.signature") return DOCUMENT_CAPABILITIES.esign;
  if (["doc.pay_now", "doc.payment_schedule"].includes(id)) return DOCUMENT_CAPABILITIES.payments;
  return null;
}

export function definitionRequiredCapabilities(definition: unknown): Set<string> {
  const required = new Set<string>();
  const visit = (value: unknown, key = "") => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = asObject(value);
    const outputCapability = documentOutputCapability(object);
    if (outputCapability) required.add(outputCapability);
    const itemCapability = workflowItemCapability(object);
    if (itemCapability && Object.prototype.hasOwnProperty.call(object, "writes")) required.add(itemCapability);
    const widget = asObject(object.props).widget ?? asObject(object.props).widget_id;
    const requiredByWidget = widgetCapability(widget);
    if (requiredByWidget) required.add(requiredByWidget);
    for (const [childKey, child] of Object.entries(object)) visit(child, childKey);
  };
  visit(definition);
  return required;
}

export function requireDefinitionCapabilities(state: DocumentCapabilityState, definition: unknown) {
  // Capability-gated elements are valid template content. Templates are often
  // shared between organizations with different plans, so rejecting the whole
  // definition makes them needlessly undeployable. Runtime projections below
  // preserve these elements and mark them disabled instead. Keep this function
  // as a compatibility no-op for callers that still invoke the old guard.
  void state;
  void definition;
}

export function capabilityDisabledPatch(capability: string): JsonObject {
  const label = capability === DOCUMENT_CAPABILITIES.esign ? "E-signature" : "Payments";
  return {
    disabled: true,
    disabled_capability: capability,
    disabled_reason: `${label} is disabled for this organization.`
  };
}

function annotateCapability<T extends JsonObject>(value: T, capability: string | null, state: DocumentCapabilityState): T {
  if (!capability || documentCapabilityEnabled(state, capability)) return value;
  return { ...value, ...capabilityDisabledPatch(capability) } as T;
}

export function filterWorkflowByCapabilities(definition: JsonObject, state: DocumentCapabilityState): JsonObject {
  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  return {
    ...definition,
    steps: steps.map((rawStep) => {
      const step = asObject(rawStep);
      const items = (Array.isArray(step.items) ? step.items : [])
        .map((item) => annotateCapability(asObject(item), workflowItemCapability(item), state));
      const sections = (Array.isArray(step.sections) ? step.sections : []).map((rawSection) => {
        const section = asObject(rawSection);
        return {
          ...section,
          items: (Array.isArray(section.items) ? section.items : [])
            .map((item) => annotateCapability(asObject(item), workflowItemCapability(item), state))
        };
      });
      return { ...step, ...(Array.isArray(step.items) ? { items } : {}), ...(Array.isArray(step.sections) ? { sections } : {}) };
    })
  };
}

export function filterOutputDefinitionsByCapabilities(definitions: JsonObject, state: DocumentCapabilityState): JsonObject {
  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => {
    const object = asObject(definition);
    return [key, annotateCapability(object, documentOutputCapability(object), state)];
  }));
}

export function filterParamDefinitionsByCapabilities(definitions: JsonObject, state: DocumentCapabilityState): JsonObject {
  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => {
    const object = asObject(definition);
    const capability = cleanText(object.type).toLowerCase() === "payment_schedule" ? DOCUMENT_CAPABILITIES.payments : null;
    return [key, annotateCapability(object, capability, state)];
  }));
}

export function filterDocumentDefinitionByCapabilities(definition: JsonObject, state: DocumentCapabilityState): JsonObject {
  const filterNode = (rawNode: unknown): JsonObject | null => {
    const node = asObject(rawNode);
    const props = asObject(node.props);
    const capability = widgetCapability(props.widget ?? props.widget_id);
    const children = Array.isArray(node.children)
      ? node.children.map(filterNode).filter((child): child is JsonObject => child !== null)
      : undefined;
    const next = { ...node, ...(children ? { children } : {}) };
    if (!capability || documentCapabilityEnabled(state, capability)) return next;
    return {
      ...next,
      props: { ...props, ...capabilityDisabledPatch(capability) }
    };
  };
  const pages = (Array.isArray(definition.pages) ? definition.pages : []).map((rawPage) => {
    const page = asObject(rawPage);
    const children = (Array.isArray(page.children) ? page.children : [])
      .map(filterNode)
      .filter((child): child is JsonObject => child !== null);
    return { ...page, children };
  });
  return {
    ...definition,
    pages,
    ...(Object.keys(asObject(definition.root)).length ? { root: filterNode(definition.root) } : {}),
    params: filterParamDefinitionsByCapabilities(asObject(definition.params), state),
    outputs: filterOutputDefinitionsByCapabilities(asObject(definition.outputs), state)
  };
}
