import { DEFAULT_SCOPE_TEMPLATES } from "../../scopes/presets/index.js";
import { INDUSTRY_SCOPE_TEMPLATES } from "../../scopes/presets/industry.js";
import type { Generator } from "./index.js";

/**
 * One-shot: the scope library from today's preset builders. A default keeps its place in the list as `sort_order`;
 * `metadata.preset_revision` is dropped (the library entry's revision and sha256 replace it).
 */
const entry = (definition: unknown, sortOrder?: number) => {
  const data = JSON.parse(JSON.stringify(definition)) as Record<string, any>;
  const { preset_revision: _revision, ...metadata } = data.metadata || {};
  data.metadata = metadata;
  if (sortOrder !== undefined) data.sort_order = sortOrder;
  return { id: String(data.id), data };
};

export const scopeTemplateGenerator: Generator = {
  kind: "scope_template",
  run: () => [
    ...DEFAULT_SCOPE_TEMPLATES.map((definition, index) => entry(definition, index)),
    ...Object.values(INDUSTRY_SCOPE_TEMPLATES).map((make) => entry(make()))
  ]
};
