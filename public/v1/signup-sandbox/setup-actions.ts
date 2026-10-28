import { env } from "../src/config/env.js";
import { PlatformError, badRequest, forbidden } from "../platform/errors.js";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { readOrganization, type JsonObject } from "../platform/storage.js";

/**
 * The procedural steps of a signup sandbox configuration (config-library kind `sandbox_configuration`), as published
 * actions an entry names in its ordered `setup` list (docs/architecture/config-library.md). The sandbox runs them as
 * the new test organization's owner, right after it is created; they never run anywhere else: each refuses an
 * organization that is not a sandbox test organization, and production. Each one reuses the domain writer or seeder
 * it names; nothing here knows which configuration asked for it.
 */

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown) => String(value ?? "").trim();
const TEMPLATE_ID = { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,119}$" };

async function sandboxOwner(ctx: PublicationContext): Promise<PlatformAuthContext> {
  if (env.isProduction) throw forbidden("sandbox_setup_production", "Sandbox setup steps never run in production.");
  if (!ctx.auth) throw forbidden("sandbox_setup_person_required", "Sandbox setup steps run as the test organization's owner.");
  const organization = await readOrganization(ctx.organizationId);
  if (object(organization.metadata).sandbox_test_org !== true) throw forbidden("sandbox_setup_test_org_required", "Sandbox setup steps only change sandbox test organizations.");
  return ctx.auth;
}

const branchOf = (ctx: PublicationContext, input: Record<string, unknown>) => text(input.branch_id) || ctx.branchId || "default";

/**
 * A scope template to start from: the library's `scope_template` entry (without its library `sort_order`, which
 * places presets in the scope library and is not part of the organization's template).
 */
async function scopeTemplateSource(id: string): Promise<JsonObject | null> {
  const { libraryCopy } = await import("../config-library/library.js");
  const copy = libraryCopy<JsonObject>("scope_template", id);
  if (copy) delete copy.sort_order;
  return copy;
}

type Step = {
  id: string;
  description: string;
  input: Record<string, unknown>;
  required?: string[];
  run(ctx: PublicationContext, owner: PlatformAuthContext, input: Record<string, unknown>): Promise<unknown>;
};

const STEPS: Step[] = [
  {
    id: "sandbox.scopeTemplate.install",
    description: "Installs a scope template in a sandbox test organization: `from` (a scope template in the library, or a preset) with `template`'s fields laid over it, saved as `template_id`. A template the organization already has is kept.",
    input: { template_id: TEMPLATE_ID, from: TEMPLATE_ID, template: { type: "object" }, branch_id: { type: "string" } },
    required: ["template_id"],
    async run(ctx, _owner, input) {
      const { readScopeTemplate, saveScopeTemplate } = await import("../scopes/storage.js");
      const branchId = branchOf(ctx, input), id = text(input.template_id);
      if (await readScopeTemplate(ctx.organizationId, branchId, id).catch(() => null)) return { installed: false, template_id: id };
      const from = text(input.from);
      const base = from ? await scopeTemplateSource(from) : {};
      if (!base) throw badRequest("sandbox_scope_template_missing", `There is no scope template ${from} to start from.`);
      await saveScopeTemplate(ctx.organizationId, branchId, { ...base, ...object(input.template), id });
      return { installed: true, template_id: id };
    }
  },
  {
    id: "sandbox.intakeRouting.setDefault",
    description: "Makes one scope template what every new project starts (intake routing default and manual template, no rules).",
    input: { template_id: TEMPLATE_ID, branch_id: { type: "string" } },
    required: ["template_id"],
    async run(ctx, _owner, input) {
      const { readIntakeRouting, saveIntakeRouting } = await import("../scopes/router.js");
      const branchId = branchOf(ctx, input), id = text(input.template_id);
      const routing = await readIntakeRouting(ctx.organizationId, branchId);
      await saveIntakeRouting(ctx.organizationId, branchId, {
        expected_revision: routing.revision,
        data: { ...routing, routing_mode: "default", rules: [], default_entry: "scope", default_template_id: id, manual_template_id: id }
      });
      return { template_id: id };
    }
  },
  {
    id: "sandbox.scopeFlags.only",
    description: "Turns on exactly the named scope templates and turns every other one the organization has off.",
    input: { template_ids: { type: "array", items: TEMPLATE_ID, minItems: 1, maxItems: 50 }, branch_id: { type: "string" } },
    required: ["template_ids"],
    async run(ctx, _owner, input) {
      const { listScopeTemplates, patchScopeFlags, readScopeFlagState } = await import("../scopes/storage.js");
      const branchId = branchOf(ctx, input), keep = new Set((input.template_ids as unknown[]).map(text));
      const others = (await listScopeTemplates(ctx.organizationId, branchId, { include_disabled: true })).map((template) => text(template.id)).filter((id) => id && !keep.has(id));
      const state = await readScopeFlagState(ctx.organizationId, branchId);
      await patchScopeFlags(ctx.organizationId, { expected_revision: state.revision, flags: { ...Object.fromEntries(others.map((id) => [id, false])), ...Object.fromEntries([...keep].map((id) => [id, true])) } }, branchId);
      return { on: [...keep], off: others };
    }
  },
  {
    id: "sandbox.appointments.seedCatalog",
    description: "Seeds the full sample appointment catalog (sales, installation, maintenance, repairs, deliveries, meetings). An existing catalog is kept.",
    input: {},
    async run(ctx) { await (await import("../appointments/defaults.js")).seedInstantFullAppointmentCatalog(ctx.organizationId); return { seeded: true }; }
  },
  {
    id: "sandbox.roofing.seedDocuments",
    description: "Copies every document default from the library into the organization, the roofing sales pack included (priced from its price book).",
    input: {},
    async run(ctx, owner) { await (await import("../documents/library-copies.js")).ensureDefaultDocumentAssets(ctx.organizationId, owner, { refresh: true }); return { seeded: true }; }
  },
  {
    id: "sandbox.roofing.seedMaterialsLibrary",
    description: "Seeds the sample roofing materials library.",
    input: {},
    async run(ctx, owner) { await (await import("../materials/roofing-library.js")).seedInstantRoofingLibrary(ctx.organizationId, owner); return { seeded: true }; }
  },
  {
    id: "sandbox.labor.seedPaySheets",
    description: "Seeds sample in-house groups, outside companies and their pay sheets.",
    input: {},
    async run(ctx, owner) { await (await import("../labor/sample-pay-sheets.js")).seedInstantPaySheets(ctx.organizationId, owner); return { seeded: true }; }
  },
  {
    id: "sandbox.payroll.seedPayRules",
    description: "Seeds the sample pay rules and pay plans.",
    input: {},
    async run(ctx, owner) { await (await import("../payroll/sample-pay-rules.js")).seedSamplePayRules(ctx.organizationId, owner); return { seeded: true }; }
  },
  {
    id: "sandbox.people.seedRoofing",
    description: "Seeds a roofing company's people: roles, departments, groups, outside companies and pay. Nobody is invited or messaged.",
    input: {},
    async run(_ctx, owner) { await (await import("../development/roofing-people.js")).seedRoofingPeople(owner); return { seeded: true }; }
  },
  {
    id: "sandbox.communications.completeOnboarding",
    description: "Finishes development phone onboarding with the development host's one verified transport. Without one, setup stays pending: no number or carrier approval is ever made up.",
    input: {},
    async run(_ctx, owner) {
      try { await (await import("../comms/calls/development.js")).completeDevelopmentOnboarding(owner); return { completed: true }; }
      catch (error) {
        if (error instanceof PlatformError && error.code === "development_transport_required") return { completed: false, pending: true };
        throw error;
      }
    }
  }
];

export const SANDBOX_SETUP_ACTION_IDS = STEPS.map((step) => step.id);

export function registerSandboxSetupActions() {
  const implementation = backendImplementationDigest();
  for (const step of STEPS) {
    registerAction({
      id: step.id, version: "1", implementation, domain: "signup-sandbox", description: step.description,
      inputSchema: { type: "object", additionalProperties: false, properties: step.input, ...(step.required ? { required: step.required } : {}) },
      outputSchema: { type: "object" },
      effect: "write",
      // Run as the test organization's owner by the sandbox; an agent working in a test organization may run one too.
      executionKinds: ["api", "agent"],
      idempotency: "required",
      policy: { scopes: ["organization"], permissions: ["manage_company_settings"] },
      execute: async (ctx, _target, input) => step.run(ctx, await sandboxOwner(ctx), input)
    });
  }
}
