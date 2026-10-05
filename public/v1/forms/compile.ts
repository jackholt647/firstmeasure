import { validateModuleDefinition, type ModuleDefinition } from "../documents/modules/schemas.js";
import { estimateOutputSchema, formItems, type FormDefinition, type FormItem } from "./contracts.js";

/**
 * Compiles a form definition into a workflow document module: answers are the
 * module inputs, the calculation is the module source, and the estimate is a
 * declared read export. Publishing stores it content-addressed, so a published
 * form (questions and pricing together) is an immutable version.
 */

const string = { type: "string", maxLength: 4000 };

function answerSchema(item: FormItem): Record<string, unknown> {
  switch (item.kind) {
    case "contact": return { type: "object", additionalProperties: false, properties: { name: { type: "string", maxLength: 120 }, email: { type: "string", maxLength: 320 }, phone: { type: "string", maxLength: 40 } } };
    case "number": return { type: "number" };
    case "multi_select": return { type: "array", maxItems: 40, items: { type: "string", maxLength: 80 } };
    case "boolean":
    case "consent": return { type: "boolean" };
    case "appointment": return { type: "object", additionalProperties: false, properties: { start_at: { type: "string", maxLength: 40 } } };
    case "property_measurement": return { type: "object", additionalProperties: true };
    case "select": return { type: "string", maxLength: 80 };
    default: return string;
  }
}

export function formInputSchema(definition: FormDefinition) {
  const properties: Record<string, unknown> = {};
  for (const item of formItems(definition)) if (item.param) properties[item.param] = answerSchema(item);
  return { type: "object", additionalProperties: false, properties };
}

/**
 * The standard estimator. It runs in the module sandbox with `inputs` (the
 * answers) and `parameters` (the form's price table) in scope, so the same
 * code prices roofing by measured area, fencing by length or a flat service.
 */
export const STANDARD_ESTIMATOR_SOURCE = `
const at = (path) => {
  let value = inputs;
  for (const part of String(path).split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
};
const empty = (value) => value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length);
const matches = (condition) => {
  const actual = at(condition.param);
  const expected = condition.value;
  switch (condition.op) {
    case 'answered': return !empty(actual);
    case 'empty': return empty(actual);
    case 'in': return Array.isArray(expected) && (Array.isArray(actual) ? actual.some((entry) => expected.includes(entry)) : expected.includes(actual));
    case 'neq': return Array.isArray(actual) ? !actual.includes(expected) : String(actual ?? '') !== String(expected ?? '');
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    default: return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '') === String(expected ?? '');
  }
};
const all = (conditions) => (conditions || []).every(matches);

const usesQuantity = !!parameters.quantity.param;
const answered = usesQuantity ? Number(at(parameters.quantity.param)) : NaN;
const known = Number.isFinite(answered) && answered > 0;
const base = known ? answered : Number(parameters.quantity.fallback) || 0;
const quantity = base * (1 + (Number(parameters.quantity.waste_percent) || 0) / 100);
if (usesQuantity && quantity <= 0) throw new Error('A quantity is required to estimate this request.');

const applied = (parameters.adjustments || []).filter((adjustment) => all(adjustment.when));
const factor = applied.reduce((total, adjustment) => total * (1 + adjustment.percent / 100), 1);
const step = Number(parameters.round_to) || 1;
const round = (value) => Math.max(0, Math.round(value / step) * step);

const options = parameters.options.filter((option) => all(option.visible_when)).map((option) => {
  const low = Math.max(option.minimum || 0, (option.flat_low + quantity * option.low_rate) * factor);
  const high = Math.max(low, (option.flat_high + quantity * option.high_rate) * factor);
  const floor = option.minimum || 0;
  return { id: option.id, label: option.label, description: option.description || '', low: Math.max(floor, round(low)), high: Math.max(floor, round(low), round(high)) };
});
if (!options.length) throw new Error('No pricing option applies to these answers.');

const estimate = {
  currency: parameters.currency,
  low: Math.min(...options.map((option) => option.low)),
  high: Math.max(...options.map((option) => option.high)),
  options,
  adjustments: applied.map((adjustment) => ({ label: adjustment.label, percent: adjustment.percent })),
  disclaimer: parameters.disclaimer || ''
};
if (usesQuantity) {
  estimate.quantity = { value: Math.round(quantity * 100) / 100, unit: parameters.quantity.unit || '', label: parameters.quantity.label || 'Quantity', source: known ? 'answer' : 'fallback' };
}
return { outputs: { estimate } };
`;

const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");

export function calculationSource(definition: FormDefinition) {
  const calculation = definition.calculation;
  if (!calculation) return "return { outputs: {} };";
  const parameters = calculation.mode === "pricing" ? calculation.pricing : calculation.parameters;
  // JSON is a subset of JavaScript once the two line-separator characters are escaped.
  const literal = JSON.stringify(parameters).replace(LINE_SEPARATORS, (character) => `\\u${character.charCodeAt(0).toString(16)}`);
  return `const parameters = ${literal};\n${calculation.mode === "pricing" ? STANDARD_ESTIMATOR_SOURCE : calculation.source}`;
}

function workflowItem(item: FormItem) {
  const { id, kind, param, visible_when, maps_to, ...config } = item;
  return {
    ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== "" && value !== undefined && !(Array.isArray(value) && !value.length))),
    id,
    kind,
    ...(param ? { writes: `params.${param}` } : {}),
    ...(visible_when.length ? { visible_when } : {})
  };
}

export function compileFormModule(name: string, definition: FormDefinition): ModuleDefinition {
  const inputSchema = formInputSchema(definition);
  const hasEstimate = !!definition.calculation;
  return validateModuleDefinition({
    name: name.slice(0, 200) || "Form",
    kind: "workflow",
    tags: ["form"],
    inputSchema,
    outputSchema: hasEstimate ? estimateOutputSchema : { type: "object", additionalProperties: false },
    exports: {
      answers: { path: "/inputs", schema: inputSchema, access: "read", description: "Answers submitted through the form." },
      ...(hasEstimate ? { estimate: { path: "/outputs/estimate", schema: estimateOutputSchema.properties.estimate, access: "read", description: "The estimate calculated from the answers." } } : {})
    },
    bindings: {},
    source: calculationSource(definition),
    workflow: {
      schema_version: 1,
      name: name.slice(0, 200) || "Form",
      contract: { params: Object.fromEntries(Object.entries(inputSchema.properties).map(([key, schema]) => [key, { type: (schema as { type: string }).type }])) },
      steps: definition.steps.map((step) => ({
        id: step.id,
        ...(step.title ? { title: step.title } : {}),
        audience: ["customer"],
        ...(step.visible_when.length ? { visible_when: step.visible_when } : {}),
        items: step.items.map(workflowItem)
      }))
    }
  });
}
