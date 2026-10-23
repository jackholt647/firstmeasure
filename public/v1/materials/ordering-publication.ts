import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { forbidden } from "../platform/errors.js";
import { createShoppingList, preparePurchaseOrder, purchaseOrderInputSchema, shoppingListInputSchema } from "./ordering.js";

/** The order window's purchase orders and shopping lists as published actions; the same service as its HTTP routes. */
export function registerMaterialOrderingPublication() {
  const auth = (ctx: PublicationContext) => { if (!ctx.auth) throw forbidden("materials_ordering_user", "A signed-in person writes purchase orders and shopping lists."); return ctx.auth; };
  const policy = { scopes: ["project" as const], permissions: ["manage_projects"], capabilities: ["platform.materials"] };
  registerAction({
    id: "materials.purchase_order.write", version: "1", domain: "materials", implementation: backendImplementationDigest(),
    description: "Write the purchase order for one supplier's part of a material order as a purchase_order document, numbered from the organization's sequence the first time. The same key keeps the same document. Returns its document id, PO number and params. Sending it is a separate step.",
    inputSchema: zodToJsonSchema(purchaseOrderInputSchema, { $refStrategy: "none" }) as Record<string, unknown>, outputSchema: { type: "object" },
    policy, effect: "write", executionKinds: ["api", "agent", "module"], idempotency: "required",
    execute: async (ctx, target, input) => { const result = await preparePurchaseOrder(ctx.organizationId, target.projectId!, input, auth(ctx)); return { document_id: result.document_id, po_number: result.po_number, title: result.title, params: result.params }; }
  });
  registerAction({
    id: "materials.shopping_list.create", version: "1", domain: "materials", implementation: backendImplementationDigest(),
    description: "Make a pickup shopping list: a project checklist of the given materials grouped by supplier, assigned to the people or groups who will pick them up, who check items off in their checklists.",
    inputSchema: zodToJsonSchema(shoppingListInputSchema, { $refStrategy: "none" }) as Record<string, unknown>, outputSchema: { type: "object" },
    policy, effect: "write", executionKinds: ["api", "agent", "module"], idempotency: "required",
    execute: async (ctx, target, input) => createShoppingList(ctx.organizationId, target.projectId!, input, auth(ctx))
  });
}
