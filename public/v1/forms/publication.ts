import { registerDataProvider } from "../platform/publication/providers.js";
import { forbidden } from "../platform/errors.js";
import { contentHash } from "../platform/publication/validation.js";
import { listForms } from "./service.js";

const text = { type: "string" };
let registered = false;

/**
 * Published form data. The catalog is what the form widgets are authorized
 * against; a widget then loads its own form through the Forms API, which
 * re-checks access. Editing goes through the assistant's forms tools and the
 * Forms API, not through publication.
 */
export function registerFormsPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "forms", version: "1", apps: ["settings"], exports: {
    catalog: {
      description: "Website forms (lead capture, appointment booking, instant estimates): each form's name, status, what it does and its submission count.",
      schemaVersion: "1",
      schema: { type: "object", required: ["forms"], additionalProperties: false, properties: { forms: { type: "array", items: { type: "object", required: ["id", "name", "status"], additionalProperties: false, properties: { id: text, name: text, status: text, kind: text, has_unpublished_changes: { type: "boolean" }, submissions: { type: "integer" }, updated_at: text } } } } },
      access: { scopes: ["organization"], permissions: ["manage_company_settings"] },
      read: async (ctx) => {
        if (!ctx.auth) throw forbidden("forms_user", "A signed-in user is required.");
        const forms = (await listForms(ctx.auth)).map((form) => ({ id: form.id, name: form.name, status: form.status, kind: form.features.appointment ? "appointment" : form.features.estimate ? "estimate" : "lead", has_unpublished_changes: form.has_unpublished_changes, submissions: form.submissions.count, updated_at: form.updated_at }));
        return { value: { forms }, revision: contentHash(forms) };
      }
    }
  } });
}
