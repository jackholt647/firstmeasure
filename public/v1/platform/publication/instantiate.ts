import type { BindingDefinition, TargetRef } from "./contracts.js";
import { jsonClone } from "./validation.js";
import { badRequest } from "../errors.js";

/** Resolve declared template context tokens once, when creating an instance.
 * Never interpolate arbitrary strings, source code or domain arguments. */
export function instantiateBindings<T extends Record<string, BindingDefinition>>(bindings: T, context: { organizationId: string; projectId?: string; branchId?: string }): T {
  const result = jsonClone(bindings);
  const resolve = (target: TargetRef) => {
    if (target.organizationId === "$organization") target.organizationId = context.organizationId;
    if (target.projectId === "$project") {
      if (!context.projectId) throw badRequest("binding_project_required", "This template needs a project instance.");
      target.projectId = context.projectId;
    }
    if (target.branchId === "$branch") target.branchId = context.branchId || "default";
    if (target.id === "$project") target.id = context.projectId;
  };
  for (const binding of Object.values(result)) {
    if (binding.kind === "data") resolve(binding.source.target);
    if (binding.kind === "action") resolve(binding.action.target);
  }
  return result;
}
