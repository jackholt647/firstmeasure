import type { FastifyPluginAsync } from "fastify";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError, z } from "zod";

import { PlatformError } from "../../platform/errors.js";
import {
  CRM_COLLECTIONS,
  asObject,
  deleteCrmDocument,
  ensureCrmStorage,
  listCrmDocuments,
  readCrmDocument,
  upsertCrmDocument
} from "./storage.js";
import { addLeadContactNote, addLeadFollowup, addLeadNote, commitLeadImport, createLeadCustomField, deleteLeadCustomField, ensureLeadDatabase, exportSelectedLeads, leadDetail, leadFields, leadFilterOptions, leadViewer, previewLeadImport, queryLeads, reassignSelectedLeads, updateLeadContact, updateLeadCustomField, updateLeadRecord } from "./leads.js";
import { acquisitionCampaignReport, attachReferralOrganization, ensureReferralDatabase, getReferralPartner, listAcquisitionCampaigns, listReferralPartners, referralRewardReport, referralRows, saveAcquisitionCampaign, saveReferralPartner, saveReferralPartnerLogo, searchReferralOrganizations, updateReferralRewardStatus } from "./referrals.js";

const objectSchema = z.object({}).passthrough();
const CRM_API_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const registerCrmApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, success: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, success: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, success: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  await ensureCrmStorage();
  await ensureLeadDatabase();
  await ensureReferralDatabase();

  app.get("/", async () => ({
    ok: true,
    success: true,
    api: "crm",
    collections: CRM_COLLECTIONS,
    routes: {
      global: "/global/:collection",
      organization: "/organizations/:orgId/:collection",
      leadFields: "/leads/fields",
      leadFilterOptions: "/leads/filter-options",
      leadQuery: "/leads/query",
      leadDetail: "/leads/:leadId/detail",
      leadViewer: "/leads/:leadId/viewer",
      leadExport: "/leads/export",
      leadReassign: "/leads/reassign",
      leadImportPreview: "/leads/imports/preview",
      leadImportCommit: "/leads/imports/:importId/commit",
      referralPartners: "/referrals/partners",
      referralRewards: "/referrals/rewards",
      leadSearch: "/organizations/:orgId/leads/search",
      dashboard: "/organizations/:orgId/dashboard"
    }
  }));

  app.get("/leads/fields", async () => leadFields());

  app.post("/leads/custom-fields", async (request, reply) => {
    const response = await createLeadCustomField(asObject(request.body));
    reply.code(201);
    return response;
  });

  app.patch("/leads/custom-fields/:fieldKey", async (request) => updateLeadCustomField(param(request.params, "fieldKey"), asObject(request.body)));

  app.delete("/leads/custom-fields/:fieldKey", async (request) => deleteLeadCustomField(param(request.params, "fieldKey"), asObject(request.body)));

  app.post("/leads/query", async (request) => queryLeads(asObject(request.body)));

  app.post("/leads/filter-options", async (request) => leadFilterOptions(asObject(request.body)));

  app.get("/leads/:leadId/detail", async (request) => leadDetail(param(request.params, "leadId")));

  app.get("/leads/:leadId/viewer", async (request) => leadViewer(param(request.params, "leadId")));

  app.patch("/leads/:leadId", async (request) => updateLeadRecord(param(request.params, "leadId"), asObject(request.body)));

  app.patch("/leads/:leadId/contacts/:contactId", async (request) => updateLeadContact(param(request.params, "leadId"), param(request.params, "contactId"), asObject(request.body)));

  app.post("/leads/:leadId/notes", async (request, reply) => {
    const response = await addLeadNote(param(request.params, "leadId"), asObject(request.body));
    reply.code(201);
    return response;
  });

  app.post("/leads/:leadId/followups", async (request, reply) => {
    const response = await addLeadFollowup(param(request.params, "leadId"), asObject(request.body));
    reply.code(201);
    return response;
  });

  app.post("/leads/:leadId/contacts/:contactId/notes", async (request, reply) => {
    const response = await addLeadContactNote(param(request.params, "leadId"), param(request.params, "contactId"), asObject(request.body));
    reply.code(201);
    return response;
  });

  app.post("/leads/export", async (request) => exportSelectedLeads(asObject(request.body)));

  app.post("/leads/reassign", async (request) => reassignSelectedLeads(asObject(request.body)));

  app.post("/leads/imports/preview", async (request) => previewLeadImport(asObject(request.body)));

  app.post("/leads/imports/:importId/commit", async (request) => commitLeadImport(param(request.params, "importId"), asObject(request.body)));

  app.get("/referrals/partners", async () => ({
    ok: true,
    success: true,
    partners: listReferralPartners()
  }));

  app.get("/referrals/partners/:partnerId", async (request) => getReferralPartner(param(request.params, "partnerId")));

  app.post("/referrals/partners", async (request, reply) => {
    const response = await saveReferralPartner(asObject(request.body));
    reply.code(201);
    return response;
  });

  app.post("/referrals/partners/:partnerId/logo", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      reply.code(400);
      return { ok: false, success: false, error: "logo_file_required", message: "Logo file is required." };
    }
    return saveReferralPartnerLogo(param(request.params, "partnerId"), file);
  });

  app.get("/referrals/logos/:fileName", async (request, reply) => {
    const fileName = path.basename(param(request.params, "fileName"));
    const absolutePath = path.join(path.resolve(process.cwd(), process.env.CRM_STORAGE_ROOT ?? "storage/crm"), "referral-logos", fileName);
    const content = await readFile(absolutePath);
    const ext = path.extname(fileName).toLowerCase();
    const type = ext === ".svg" ? "image/svg+xml"
      : ext === ".webp" ? "image/webp"
        : ext === ".gif" ? "image/gif"
          : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
            : ext === ".png" ? "image/png"
              : "application/octet-stream";
    reply.header("content-type", type);
    reply.header("cache-control", "public, max-age=31536000, immutable");
    return content;
  });

  app.get("/referrals/organizations/search", async (request) => {
    const query = asObject(request.query);
    const organizations = await searchReferralOrganizations(String(query.q ?? query.query ?? ""), Number(query.limit ?? 120) || 120);
    return { ok: true, success: true, organizations, rows: organizations };
  });

  app.post("/referrals/partners/:partnerId/attach-organization", async (request) => attachReferralOrganization({
    ...asObject(request.body),
    partner_id: param(request.params, "partnerId")
  }));

  app.get("/referrals/acquisition/campaigns", async () => ({
    ok: true,
    success: true,
    campaigns: listAcquisitionCampaigns()
  }));

  app.post("/referrals/acquisition/campaigns", async (request, reply) => {
    const response = await saveAcquisitionCampaign(asObject(request.body));
    reply.code(201);
    return response;
  });

  app.get("/referrals/acquisition/report", async (request) => acquisitionCampaignReport(asObject(request.query)));

  app.post("/referrals/acquisition/report", async (request) => acquisitionCampaignReport(asObject(request.body)));

  app.get("/referrals/acquisition/landing-pages", async () => {
    const discovered = await discoverLandingPages();
    return {
      ok: true,
      success: true,
      ...discovered,
      landing_pages: discovered.pages
    };
  });

  app.post("/referrals/acquisition/landing-pages/clone", async (request, reply) => {
    const cloned = await cloneLandingPage(asObject(request.body));
    reply.code(201);
    return {
      ok: true,
      success: true,
      ...cloned
    };
  });

  app.get("/referrals/rewards", async () => ({
    ok: true,
    success: true,
    rows: referralRewardReport(),
    rewards: referralRows("referral_reward_ledger"),
    attributions: referralRows("referral_attributions")
  }));

  app.patch("/referrals/rewards/:rewardId/status", async (request) => updateReferralRewardStatus(
    param(request.params, "rewardId"),
    String(asObject(request.body).status ?? "")
  ));

  app.get("/global/:collection", async (request) => listResponse(
    await listCrmDocuments("global", param(request.params, "collection")),
    asObject(request.query)
  ));

  app.post("/global/:collection", async (request, reply) => {
    const document = await upsertCrmDocument("global", param(request.params, "collection"), objectSchema.parse(request.body ?? {}));
    reply.code(201);
    return { ok: true, success: true, document };
  });

  app.get("/global/:collection/:id", async (request) => ({
    ok: true,
    success: true,
    document: await readCrmDocument("global", param(request.params, "collection"), param(request.params, "id"))
  }));

  app.put("/global/:collection/:id", async (request) => ({
    ok: true,
    success: true,
    document: await upsertCrmDocument("global", param(request.params, "collection"), {
      ...objectSchema.parse(request.body ?? {}),
      id: param(request.params, "id")
    }, { replace: true })
  }));

  app.patch("/global/:collection/:id", async (request) => ({
    ok: true,
    success: true,
    document: await upsertCrmDocument("global", param(request.params, "collection"), {
      ...objectSchema.parse(request.body ?? {}),
      id: param(request.params, "id")
    })
  }));

  app.delete("/global/:collection/:id", async (request) => ({
    ok: true,
    success: true,
    deleted: await deleteCrmDocument("global", param(request.params, "collection"), param(request.params, "id"))
  }));

  app.get("/organizations/:orgId/dashboard", async (request) => {
    const orgId = param(request.params, "orgId");
    const [leads, pipeline, communications, territories] = await Promise.all([
      listCrmDocuments("organization", "leads", orgId),
      listCrmDocuments("organization", "pipeline", orgId),
      listCrmDocuments("organization", "communications", orgId),
      listCrmDocuments("organization", "territories", orgId)
    ]);
    const leadStatusCounts = countBy(leads.map((doc) => String(asObject(doc.data).status || "new")));
    return {
      ok: true,
      success: true,
      organization_id: orgId,
      totals: {
        leads: leads.length,
        pipeline_items: pipeline.length,
        communications: communications.length,
        territories: territories.length
      },
      lead_status_counts: leadStatusCounts
    };
  });

  app.get("/organizations/:orgId/leads/search", async (request) => {
    const orgId = param(request.params, "orgId");
    const query = asObject(request.query);
    return listResponse(await listCrmDocuments("organization", "leads", orgId), query);
  });

  app.get("/organizations/:orgId/:collection", async (request) => listResponse(
    await listCrmDocuments("organization", param(request.params, "collection"), param(request.params, "orgId")),
    asObject(request.query)
  ));

  app.post("/organizations/:orgId/:collection", async (request, reply) => {
    const document = await upsertCrmDocument(
      "organization",
      param(request.params, "collection"),
      objectSchema.parse(request.body ?? {}),
      { orgId: param(request.params, "orgId") }
    );
    reply.code(201);
    return { ok: true, success: true, document };
  });

  app.get("/organizations/:orgId/:collection/:id", async (request) => ({
    ok: true,
    success: true,
    document: await readCrmDocument(
      "organization",
      param(request.params, "collection"),
      param(request.params, "id"),
      param(request.params, "orgId")
    )
  }));

  app.put("/organizations/:orgId/:collection/:id", async (request) => ({
    ok: true,
    success: true,
    document: await upsertCrmDocument(
      "organization",
      param(request.params, "collection"),
      { ...objectSchema.parse(request.body ?? {}), id: param(request.params, "id") },
      { replace: true, orgId: param(request.params, "orgId") }
    )
  }));

  app.patch("/organizations/:orgId/:collection/:id", async (request) => ({
    ok: true,
    success: true,
    document: await upsertCrmDocument(
      "organization",
      param(request.params, "collection"),
      { ...objectSchema.parse(request.body ?? {}), id: param(request.params, "id") },
      { orgId: param(request.params, "orgId") }
    )
  }));

  app.delete("/organizations/:orgId/:collection/:id", async (request) => ({
    ok: true,
    success: true,
    deleted: await deleteCrmDocument(
      "organization",
      param(request.params, "collection"),
      param(request.params, "id"),
      param(request.params, "orgId")
    )
  }));
};

function param(params: unknown, key: string) {
  return String(asObject(params)[key] ?? "").trim();
}

function listResponse(documents: Array<Record<string, unknown>>, query: Record<string, unknown>) {
  const search = String(query.q ?? query.search ?? "").trim().toLowerCase();
  const status = String(query.status ?? "").trim().toLowerCase();
  const offset = Math.max(0, Math.floor(Number(query.offset ?? 0)) || 0);
  const limit = Math.max(1, Math.min(500, Math.floor(Number(query.limit ?? 100)) || 100));
  const filtered = documents.filter((document) => {
    const data = asObject(document.data);
    if (status && String(data.status ?? "").toLowerCase() !== status) return false;
    if (!search) return true;
    return JSON.stringify({ id: document.id, data }).toLowerCase().includes(search);
  });
  return {
    ok: true,
    success: true,
    documents: filtered.slice(offset, offset + limit),
    count: filtered.length,
    total: filtered.length,
    pagination: {
      offset,
      limit,
      returned: Math.min(limit, Math.max(0, filtered.length - offset)),
      has_more: offset + limit < filtered.length
    }
  };
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

async function discoverLandingPages() {
  const roots = landingPageRootCandidates();
  let root = "";
  for (const candidate of roots) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) {
        root = candidate;
        break;
      }
    } catch {}
  }
  if (!root) return { pages: [], root: "", searched_roots: roots };
  const files: string[] = [];
  await walkLandingRoot(root, files);
  const pages = files
    .filter((file) => path.basename(file).toLowerCase() === "index.php")
    .map((file) => {
      const relative = path.relative(root, file).replace(/\\/g, "/");
      const directory = path.dirname(relative).replace(/\\/g, "/");
      const slug = directory === "." ? "landing" : directory.split("/").filter(Boolean).join("/");
      const variant = slug.startsWith("variants/") ? slug.replace(/^variants\//, "") : slug;
      const urlPath = directory === "."
        ? "/portal/landing/"
        : `/portal/landing/${directory.replace(/\/$/, "")}/`;
      return {
        id: slug,
        label: variant === "landing" ? "Default landing page" : variant.split("/").map(titleCase).join(" / "),
        variant,
        path: relative,
        directory: directory === "." ? "" : directory,
        url_path: urlPath,
        absolute_path: file
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  return { pages, root, searched_roots: roots };
}

async function cloneLandingPage(input: Record<string, unknown>) {
  const discovered = await discoverLandingPages();
  const root = discovered.root;
  if (!root) throw new PlatformError("landing_root_not_found", 404, "Landing page root was not found.");

  const slug = landingVariantSlug(input.slug ?? input.variant ?? input.name ?? input.label);
  if (!slug) throw new PlatformError("landing_slug_required", 400, "Landing page slug is required.");
  if (["shared", "variants", "index", "landing"].includes(slug)) {
    throw new PlatformError("landing_slug_reserved", 400, "That landing page slug is reserved.");
  }

  const source = resolveLandingCloneSource(discovered.pages, input.source ?? input.source_url_path ?? input.source_path ?? input.source_id);
  if (!source) throw new PlatformError("landing_source_not_found", 404, "Source landing page was not found.");

  const variantsRoot = path.join(root, "variants");
  const targetDir = path.join(variantsRoot, slug);
  const relativeTarget = path.relative(variantsRoot, targetDir);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new PlatformError("landing_slug_invalid", 400, "Landing page slug is invalid.");
  }
  try {
    await stat(targetDir);
    throw new PlatformError("landing_slug_exists", 409, "A landing page with that slug already exists.");
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    if ((error as any)?.code !== "ENOENT") throw error;
  }

  await mkdir(variantsRoot, { recursive: true });
  await cp(source.source_dir, targetDir, { recursive: true, errorOnExist: true, force: false });
  await ensureLandingRouterVariant(root, slug);
  const refreshed = await discoverLandingPages();
  const page = refreshed.pages.find((entry) => entry.variant === slug) ?? {
    id: `variants/${slug}`,
    label: titleCase(slug),
    variant: slug,
    path: `variants/${slug}/index.php`,
    directory: `variants/${slug}`,
    url_path: `/portal/landing/variants/${slug}/`,
    absolute_path: path.join(targetDir, "index.php")
  };
  return {
    page,
    landing_page: page,
    pages: refreshed.pages,
    landing_pages: refreshed.pages,
    root: refreshed.root,
    source: source.page
  };
}

function resolveLandingCloneSource(pages: Array<Record<string, unknown>>, sourceInput: unknown) {
  const sourceValue = String(sourceInput ?? "").trim();
  const fallback = pages.find((page) => page.variant === "measurements") ?? pages.find((page) => String(page.directory ?? "").startsWith("variants/"));
  const page = pages.find((entry) => {
    return sourceValue
      && [entry.id, entry.variant, entry.path, entry.directory, entry.url_path].some((value) => String(value ?? "") === sourceValue);
  }) ?? fallback;
  if (!page) return null;
  const absolutePath = String(page.absolute_path ?? "");
  const directory = String(page.directory ?? "");
  const sourceDir = directory ? path.dirname(absolutePath) : path.dirname(String(fallback?.absolute_path ?? absolutePath));
  return { page, source_dir: sourceDir };
}

async function ensureLandingRouterVariant(root: string, slug: string) {
  const routerPath = path.join(root, "index.php");
  let content = await readFile(routerPath, "utf8");
  const entry = `    '${slug}' => __DIR__ . '/variants/${slug}/index.php',`;
  if (content.includes(`'${slug}' =>`) || content.includes(`"${slug}" =>`)) return;
  const marker = "];";
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) throw new PlatformError("landing_router_invalid", 500, "Landing page router could not be updated.");
  content = `${content.slice(0, markerIndex)}${entry}\n${content.slice(markerIndex)}`;
  await writeFile(routerPath, content, "utf8");
}

function landingVariantSlug(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function landingPageRootCandidates() {
  const roots = new Set<string>();
  const add = (value: unknown) => {
    const raw = String(value ?? "").trim();
    if (raw) roots.add(path.resolve(raw));
  };
  add(process.env.PORTAL_LANDING_ROOT);
  for (const base of [process.cwd(), CRM_API_MODULE_DIR]) {
    let cursor = path.resolve(base);
    for (let depth = 0; depth < 8; depth += 1) {
      add(path.join(cursor, "portal", "landing"));
      add(path.join(cursor, "public", "portal", "landing"));
      cursor = path.dirname(cursor);
    }
  }
  return [...roots];
}

async function walkLandingRoot(directory: string, files: string[]) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["shared", "node_modules", "storage"].includes(entry.name)) continue;
      await walkLandingRoot(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

function titleCase(value: string) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
