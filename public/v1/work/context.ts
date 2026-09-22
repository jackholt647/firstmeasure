// Automation data context: read access to platform data from any automation
// input template or condition. Subsystems register namespace providers here;
// a scope template can then reference `{{organization.name}}`,
// `{{users.by_role.sales_appointments.0.email}}`, `{{pricebook.default.catalog...}}`
// or any future namespace without engine changes. Providers are loaded lazily
// (only when a path references their namespace) and cached per event
// execution, so unused namespaces cost nothing.

import type { JsonObject } from "./storage.js";

export type WorkContextScope = {
  organization_id: string;
  branch_id: string;
  project_id: string;
  event: JsonObject;
  plan: JsonObject;
  node: JsonObject;
};

// A provider receives the scope plus the remaining path segments after its
// namespace. Most providers ignore `restPath` and return their whole
// namespace object (the resolver walks the rest); parameterized providers
// (e.g. branch modules) may use restPath[0] as a key.
export type WorkContextProvider = (scope: WorkContextScope, restPath: string[]) => Promise<unknown>;

const providers = new Map<string, WorkContextProvider>();

export function registerWorkContextProvider(namespace: string, provider: WorkContextProvider) {
  const key = String(namespace || "").trim();
  if (!key) throw new Error("A context provider namespace is required.");
  providers.set(key, provider);
}

export function hasWorkContextProvider(namespace: string) {
  return providers.has(String(namespace || "").trim());
}

export function listWorkContextProviders() {
  return [...providers.keys()].sort();
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function walkPath(source: unknown, path: string[]) {
  return path.reduce<unknown>((value, key) => {
    if (Array.isArray(value)) {
      const index = Number(key);
      return Number.isInteger(index) ? value[index] : undefined;
    }
    if (value && typeof value === "object") return (value as JsonObject)[key];
    return undefined;
  }, source);
}

// Per-event-execution resolver with caching. `cacheKeyFor` keeps parameterized
// providers (branch.<moduleId>) cached per parameter.
export function createWorkDataResolver(scope: WorkContextScope) {
  const cache = new Map<string, Promise<unknown>>();
  return {
    canResolve(namespace: string) {
      return providers.has(namespace);
    },
    async resolve(path: string[]): Promise<unknown> {
      const [namespace, ...rest] = path;
      const provider = providers.get(cleanText(namespace));
      if (!provider) return undefined;
      const cacheKey = `${namespace}:${cleanText(rest[0])}`;
      if (!cache.has(cacheKey)) {
        cache.set(cacheKey, Promise.resolve(provider(scope, rest)).catch(() => undefined));
      }
      const value = await cache.get(cacheKey);
      if (value === undefined || value === null) return undefined;
      return rest.length ? walkPath(value, rest) : value;
    }
  };
}

export type WorkDataResolver = ReturnType<typeof createWorkDataResolver>;

// ── Built-in providers ─────────────────────────────────────────────────────

let builtinsRegistered = false;

export function registerBuiltinContextProviders() {
  if (builtinsRegistered) return;
  builtinsRegistered = true;

  // organization: company profile plus the org-wide settings blob.
  registerWorkContextProvider("organization", async (scope) => {
    const { readOrganization, readGlobal } = await import("../platform/storage.js");
    const organization = asObject(await readOrganization(scope.organization_id).catch(() => null));
    const global = asObject(await readGlobal(scope.organization_id).catch(() => null));
    return {
      id: scope.organization_id,
      ...asObject(organization.data || organization),
      settings: asObject(global.data)
    };
  });

  // users: sanitized org roster, plus by_id / by_role conveniences.
  registerWorkContextProvider("users", async (scope) => {
    const { listDocuments } = await import("../platform/storage.js");
    const documents = await listDocuments(scope.organization_id, "users").catch(() => []);
    const list = documents.map((document) => {
      const data = asObject(asObject(document).data);
      return {
        id: cleanText(asObject(document).id),
        name: cleanText(data.name || data.display_name),
        email: cleanText(data.email),
        phone: cleanText(data.phone),
        status: cleanText(data.status),
        roles: Array.isArray(data.roles) ? data.roles.map(cleanText).filter(Boolean) : [],
        access_role_ids: Array.isArray(data.access_role_ids) ? data.access_role_ids.map(cleanText).filter(Boolean) : []
      };
    });
    const byId = Object.fromEntries(list.map((user) => [user.id, user]));
    const byRole: Record<string, unknown[]> = {};
    for (const user of list) {
      for (const role of [...user.roles, ...user.access_role_ids]) {
        if (!byRole[role]) byRole[role] = [];
        byRole[role].push(user);
      }
    }
    return { list, count: list.length, by_id: byId, by_role: byRole };
  });

  // media: project-owned media, indexed by canonical tag for scope templates
  // such as {{media.by_tag.before_photos.0.media_id}}.
  registerWorkContextProvider("media", async (scope) => {
    const { listMedia, normalizeMediaTags } = await import("../platform/storage.js");
    const media = await listMedia(scope.organization_id).catch(() => []);
    const list = media
      .filter((entry) => {
        const item = asObject(entry);
        const owner = asObject(item.owner);
        const metadata = asObject(item.metadata);
        const projectId = cleanText(metadata.project_id || (cleanText(owner.type) === "project" ? owner.id : ""));
        return !scope.project_id || projectId === scope.project_id;
      })
      .map((entry) => {
        const item = asObject(entry);
        const owner = asObject(item.owner);
        const metadata = asObject(item.metadata);
        return {
          media_id: cleanText(item.id || item.media_id),
          kind: cleanText(item.kind),
          content_type: cleanText(item.content_type),
          file_name: cleanText(item.file_name),
          project_id: cleanText(metadata.project_id || (cleanText(owner.type) === "project" ? owner.id : "")),
          tags: normalizeMediaTags(item.tags || metadata.tags),
          created_at: cleanText(item.created_at),
          updated_at: cleanText(item.updated_at)
        };
      });
    const byTag: Record<string, unknown[]> = {};
    for (const item of list) {
      for (const tag of item.tags) {
        if (!byTag[tag]) byTag[tag] = [];
        byTag[tag].push(item);
      }
    }
    return { list, count: list.length, tags: Object.keys(byTag).sort(), by_tag: byTag };
  });

  // branch: any branch config module by id — {{branch.<moduleId>.<path>}}.
  registerWorkContextProvider("branch", async (scope, restPath) => {
    const moduleId = cleanText(restPath[0]);
    if (!moduleId) return {};
    const { readBranchModule } = await import("../platform/storage.js");
    const module = await readBranchModule(scope.organization_id, scope.branch_id || "default", moduleId).catch(() => null);
    // Returned under the module id so the resolver's path walk lines up.
    return { [moduleId]: asObject(asObject(module).data) };
  });

  // pricebook: the org's pricebooks with the default catalog loaded.
  registerWorkContextProvider("pricebook", async (scope) => {
    const { listPricebookManifests, readCatalog } = await import("../pricebook/storage.js");
    const manifests = (await listPricebookManifests().catch(() => []))
      .filter((manifest) => cleanText(asObject(asObject(manifest).organization_ref).id) === scope.organization_id);
    const defaultManifest = asObject(manifests.find((manifest) => asObject(manifest).is_default === true) || manifests[0]);
    const catalog = cleanText(defaultManifest.id)
      ? await readCatalog(cleanText(defaultManifest.id)).catch(() => null)
      : null;
    return {
      list: manifests,
      count: manifests.length,
      default: { manifest: defaultManifest, catalog: asObject(catalog) }
    };
  });

  // scopes: the org's scope templates (summaries plus definitions by id).
  registerWorkContextProvider("scopes", async (scope) => {
    const { listScopeTemplates } = await import("../scopes/storage.js");
    const templates = (await listScopeTemplates(scope.organization_id, scope.branch_id || "default", { include_disabled: true }));
    return {
      list: templates.map((template) => ({
        id: asObject(template).id,
        name: asObject(template).name,
        kind: asObject(asObject(template).definition).kind || "production",
        enabled: asObject(template).enabled !== false,
        version: asObject(template).version
      })),
      by_id: Object.fromEntries(templates.map((template) => [cleanText(asObject(template).id), template]))
    };
  });

  // money: the project's money summary (obligations, collected, expenses).
  registerWorkContextProvider("money", async (scope) => {
    if (!scope.project_id) return {};
    const { projectMoneySummary } = await import("../payments/storage.js");
    return asObject(await projectMoneySummary(scope.organization_id, scope.project_id).catch(() => ({})));
  });

  // work: the project's other scope instances — lets one scope read the
  // state of its siblings (the projection the frontend uses).
  registerWorkContextProvider("work", async (scope) => {
    if (!scope.project_id) return {};
    const { projectWorkProjection } = await import("./service.js");
    return asObject((await projectWorkProjection(scope.organization_id, scope.project_id)));
  });
}
