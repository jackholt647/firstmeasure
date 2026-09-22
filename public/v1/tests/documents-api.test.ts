import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""]
        .filter(Boolean)
        .join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-documents-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  // The documents API is mounted centrally by the integrator in src/app.ts;
  // until that lands the test registers the plugin itself.
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8").catch(() => "");
  const alreadyMounted = appSource.includes("registerDocumentsApi");
  if (!alreadyMounted) {
    const { registerDocumentsApi } = await import("../documents/api.js");
    await app.register(registerDocumentsApi, { prefix: "/v1/documents" });
  }
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOrg(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Documents Test Org",
    organization_id: `org_documents_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: {
      "platform.documents": true,
      "documents.templates_studio": true,
      "documents.workflow_authoring": true,
      "documents.theme_authoring": true,
      "documents.advanced_definition_editing": true,
      "documents.custom_folders": true,
      "documents.designer_profile": true,
      "documents.esign": true,
      "documents.payments": true,
      "documents.agent": true,
      "documents.ingestion": true,
      "platform.customer_portal": true,
      "customer_portal.payments": true,
      "platform.money": true,
      "money.take_payment": true
    }
  });
  return { orgId };
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "100 Document Lane",
      title: "Jane Homeowner",
      project_type: "residential",
      contacts: [{ name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222" }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
}

const SCOPE_ITEMS = [
  { id: "item_roof", name: "Roof replacement", description: "Tear-off and re-shingle", quantity: 1, unit: "job", unit_price: 12500 },
  { id: "item_gutter", name: "Gutter guards", description: "Leaf protection", quantity: 2, unit: "run", unit_price: 500 }
];

function findWidgetRows(widgetData: Record<string, any>) {
  for (const value of Object.values(widgetData || {})) {
    if (value && typeof value === "object" && Array.isArray((value as any).rows)) {
      return value as any;
    }
  }
  return null;
}

function walkDefinitionNodes(definition: any, visit: (node: any) => void) {
  const visitNode = (node: any) => {
    if (!node || typeof node !== "object") return;
    visit(node);
    for (const child of Array.isArray(node.children) ? node.children : []) visitNode(child);
  };
  for (const page of Array.isArray(definition?.pages) ? definition.pages : []) {
    for (const child of Array.isArray(page.children) ? page.children : []) visitNode(child);
  }
}

function findNodeByType(definition: any, type: string) {
  let found: any = null;
  walkDefinitionNodes(definition, (node) => {
    if (!found && node.type === type) found = node;
  });
  return found;
}

/** First repeater stamping the given component (documents can carry several). */
function findRepeaterFor(definition: any, component: string) {
  let found: any = null;
  walkDefinitionNodes(definition, (node) => {
    if (!found && node.type === "repeater" && node.props?.component === component) found = node;
  });
  return found;
}

/** Per-block joined text (runs concatenated), for glyph+label assertions. */
function collectBlockTexts(definition: any): string[] {
  const texts: string[] = [];
  walkDefinitionNodes(definition, (node) => {
    if (node.type !== "text") return;
    for (const block of Array.isArray(node.props?.blocks) ? node.props.blocks : []) {
      texts.push((Array.isArray(block.runs) ? block.runs : []).map((run: any) => run.text ?? "").join(""));
    }
  });
  return texts;
}

function collectTextRuns(definition: any): string[] {
  const texts: string[] = [];
  walkDefinitionNodes(definition, (node) => {
    if (node.type !== "text") return;
    for (const block of Array.isArray(node.props?.blocks) ? node.props.blocks : []) {
      for (const run of Array.isArray(block.runs) ? block.runs : []) {
        if (typeof run.text === "string") texts.push(run.text);
      }
    }
  });
  return texts;
}

test("document capability boundaries gate APIs and mark unavailable catalog elements disabled", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);

  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: {
      "documents.workflow_authoring": false,
      "documents.theme_authoring": false,
      "documents.esign": false,
      "documents.payments": false,
      "documents.ingestion": false,
      "documents.enabled_types": "invoice"
    }
  });

  const catalog = await client.request("GET", `/v1/documents/organizations/${orgId}/catalog`);
  assert.deepEqual(catalog.types.map((entry: any) => entry.id), ["invoice"]);
  assert.equal(catalog.widgets.find((entry: any) => entry.id === "doc.signature")?.disabled, true);
  assert.equal(catalog.widgets.filter((entry: any) => entry.id === "doc.pay_now" || entry.id === "doc.payment_schedule").every((entry: any) => entry.disabled === true), true);
  assert.equal(catalog.item_kinds.filter((entry: any) => entry.id === "signature" || entry.id === "payment").every((entry: any) => entry.disabled === true), true);
  assert.equal(catalog.sources.filter((entry: any) => String(entry.id).startsWith("payments.")).every((entry: any) => entry.disabled === true), true);

  const workflowDenied = await client.raw("POST", `/v1/documents/organizations/${orgId}/workflows`, {});
  assert.equal(workflowDenied.statusCode, 403);
  const themeDenied = await client.raw("POST", `/v1/documents/organizations/${orgId}/themes`, {});
  assert.equal(themeDenied.statusCode, 403);
  const ingestionDenied = await client.raw("POST", `/v1/documents/organizations/${orgId}/documents/ingest`, {});
  assert.equal(ingestionDenied.statusCode, 403);

  await createProject(client, orgId, "project_capability_boundaries");
  const typeDenied = await client.raw("POST", `/v1/documents/organizations/${orgId}/projects/project_capability_boundaries/documents`, {
    document_type: "proposal"
  });
  assert.equal(typeDenied.statusCode, 403);

  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "platform.documents": false } });
  const appDenied = await client.raw("GET", `/v1/documents/organizations/${orgId}/catalog`);
  assert.equal(appDenied.statusCode, 403);
});

test("presets seed on first list: three themes and three showcase templates that validate", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);

  const themes = await client.request("GET", `/v1/documents/organizations/${orgId}/themes`);
  const themeIds = themes.themes.map((theme: any) => theme.id);
  for (const id of ["thm_margin", "thm_triangles", "thm_clean"]) {
    assert.ok(themeIds.includes(id), `seeded theme ${id} is present`);
  }

  const templates = await client.request("GET", `/v1/documents/organizations/${orgId}/templates`);
  const templateIds = templates.templates.map((template: any) => template.id);
  for (const id of ["tpl_proposal_default", "tpl_invoice_default", "tpl_change_order_default", "tpl_one_page_legal", "tpl_three_option_proposal", "tpl_roofing_selection_to_document", "tpl_roofing_signature_payment", "tpl_roofing_good_better_best_document", "tpl_roofing_good_better_best_workflow", "tpl_roofing_completion_certificate"]) {
    assert.ok(templateIds.includes(id), `seeded template ${id} is present`);
  }

  const { FMDocModel } = await import("../documents/schemas.js");
  for (const id of ["tpl_proposal_default", "tpl_invoice_default", "tpl_change_order_default", "tpl_one_page_legal", "tpl_three_option_proposal", "tpl_roofing_selection_to_document", "tpl_roofing_signature_payment", "tpl_roofing_good_better_best_document", "tpl_roofing_good_better_best_workflow", "tpl_roofing_completion_certificate"]) {
    const detail = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/${id}`);
    assert.ok(detail.template.definition, `${id} has a published definition`);
    const result = FMDocModel.validateDocument(detail.template.definition);
    assert.ok(result.ok, `${id} definition validates: ${JSON.stringify(result.errors.slice(0, 3))}`);
    assert.ok(Number(detail.template.current_version) >= 1, `${id} has current_version >= 1`);
  }

  const roofingAgreement = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/tpl_roofing_signature_payment`);
  const coverNodes = roofingAgreement.template.definition.pages[0].children;
  const coverHero = coverNodes.find((node: any) => node.type === "image" && Number(node.frame?.w) > 500);
  assert.deepEqual(
    { x: coverHero?.frame?.x, w: coverHero?.frame?.w },
    { x: 40, w: 532 },
    "proposal presets use neutral page bounds so the selected theme owns the margins"
  );

  const catalog = await client.request("GET", `/v1/documents/organizations/${orgId}/catalog`);
  const widgetIds = catalog.widgets.map((widget: any) => widget.id);
  for (const id of ["doc.line_items", "doc.payment_schedule", "doc.pay_now", "doc.signature", "doc.form_field", "doc.workflow_field", "doc.choice_group", "doc.qr", "doc.photo", "doc.photo_grid", "doc.page_number", "doc.video"]) {
    assert.ok(widgetIds.includes(id), `catalog lists ${id}`);
  }
  assert.ok(catalog.types.some((type: any) => type.id === "proposal"), "catalog lists the proposal type");
  assert.ok(catalog.types.some((type: any) => type.id === "completion_certificate"), "catalog lists the completion certificate type");
  assert.ok(catalog.fonts.includes("Montserrat") && catalog.fonts.length === 8, "catalog lists the 8 font families");

  // Workflow layer additions: seeded workflows + item kinds + named sources.
  for (const id of ["wfl_roofing_proposal_intake", "wfl_one_page_legal", "wfl_three_option_proposal", "wfl_roofing_completion_signoff", "wfl_roofing_customer_workflow"]) {
    assert.ok(catalog.workflows.some((workflow: any) => workflow.id === id), `catalog lists seeded workflow ${id}`);
  }
  for (const id of ["text", "select", "measurements", "piece_picker", "piece_select", "line_items_review", "choice_group", "content_blocks", "review", "signature", "payment"]) {
    assert.ok(catalog.item_kinds.some((kind: any) => kind.id === id), `catalog lists item kind ${id}`);
  }
  for (const id of ["measurements.project", "pricebook.category", "materials.order_lines", "payments.obligations"]) {
    assert.ok(catalog.sources.some((source: any) => source.id === id), `catalog lists source ${id}`);
  }
  const proposalType = catalog.types.find((type: any) => type.id === "proposal");
  assert.equal(proposalType.default_workflow_id, "wfl_roofing_proposal_intake", "proposal type bundles the intake workflow");
});

test("template create, publish, version listing, and optimistic publish conflict", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const { FMDocModel } = await import("../documents/schemas.js");

  const definition = FMDocModel.createDocument({ first_page_role: "body" });
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/templates`, {
    id: "tpl_custom_test",
    name: "Custom Template",
    document_type: "generic",
    definition
  });
  assert.equal(created.template.id, "tpl_custom_test");
  assert.equal(Number(created.template.current_version), 1, "create with definition publishes v1");

  const republished = await client.request("POST", `/v1/documents/organizations/${orgId}/templates/tpl_custom_test/publish`, {
    definition,
    expected_version: 1
  });
  assert.equal(Number(republished.template.current_version), 2, "publish bumps current_version");

  const versions = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/tpl_custom_test/versions`);
  assert.equal(versions.count, 2, "both immutable versions are listed");
  assert.ok(versions.versions.every((version: any) => version.checksum), "versions carry checksums");

  const conflict = await client.raw("POST", `/v1/documents/organizations/${orgId}/templates/tpl_custom_test/publish`, {
    definition,
    expected_version: 1
  });
  assert.equal(conflict.statusCode, 409, "stale expected_version publish is rejected");
});

test("templates with disabled payment elements still publish and launch with those elements annotated", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const { FMDocModel } = await import("../documents/schemas.js");
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "documents.payments": false } });

  const definition: any = FMDocModel.createDocument({ first_page_role: "body" });
  const payNow: any = FMDocModel.createNode("widget", { frame: { x: 48, y: 80, w: 260, h: 120 } });
  payNow.props.widget = "doc.pay_now@1";
  payNow.props.config = { output_key: "payment" };
  definition.pages[0].children.push(payNow);
  definition.outputs.payment = { type: "payment", required: true, label: "Payment" };

  const template = await client.request("POST", `/v1/documents/organizations/${orgId}/templates`, {
    id: "tpl_disabled_payment",
    name: "Payment template",
    document_type: "generic",
    definition
  });
  assert.equal(Number(template.template.current_version), 1);
  await createProject(client, orgId, "project_disabled_payment");
  const launched = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/project_disabled_payment/documents`, {
    document_type: "generic",
    template_id: "tpl_disabled_payment"
  });
  assert.equal(launched.document.output_defs.payment.disabled, true);
  assert.deepEqual(launched.missing_params, []);
  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${launched.document.id}/resolve`, {});
  const node = resolved.resolved_definition.pages[0].children.find((entry: any) => entry.props?.widget === "doc.pay_now@1");
  assert.equal(node.props.disabled, true);
  assert.equal(node.props.disabled_capability, "documents.payments");
});

test("Kitchen finish selections workflow can be copied while document payments are disabled", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const seeded = await client.request("GET", `/v1/documents/organizations/${orgId}/workflows/wfl_kitchen_selections`);
  assert.equal(seeded.workflow.name, "Kitchen finish selections");
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "documents.payments": false } });
  const copied = await client.request("POST", `/v1/documents/organizations/${orgId}/workflows`, {
    name: "Kitchen finish selections copy",
    definition: seeded.workflow.definition
  });
  assert.equal(Number(copied.workflow.current_version), 1);
  assert.equal(copied.workflow.name, "Kitchen finish selections copy");
});

test("new and seeded Doc Studio themes snapshot the company palette and document font", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const palette = ["#123456", "#234567", "#345678", "#456789", "#56789A", "#6789AB"];
  await client.request("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/presentation_style`, {
    data: {
      branding: { colors: { primary: palette[0], secondary: palette[1], accent: palette[0], palette } },
      proposal_defaults: { font_family: "Poppins" }
    }
  });

  // The automatically-created presets use a creation-time snapshot too.
  const listedThemes = await client.request("GET", `/v1/documents/organizations/${orgId}/themes`);
  assert.ok(listedThemes.themes.every((theme: any) => theme.definition?.tokens), "theme list carries current definitions for accurate Doc Studio cards");
  const preset = await client.request("GET", `/v1/documents/organizations/${orgId}/themes/thm_margin`);
  assert.equal(preset.theme.definition.tokens.colors.primary, palette[0]);
  assert.equal(preset.theme.definition.tokens.colors.secondary, palette[1]);
  assert.equal(preset.theme.definition.tokens.colors.accent, palette[1]);
  assert.deepEqual(
    palette.map((_, index) => preset.theme.definition.tokens.colors[`palette_${index + 1}`]),
    palette,
    "all six company palette colors are available as theme tokens"
  );
  assert.equal(preset.theme.definition.tokens.fonts.display, "Poppins");
  assert.equal(preset.theme.definition.tokens.fonts.body, "Poppins");
  assert.deepEqual(
    preset.theme.definition.page_masters[0].content_inset,
    { top: 48, left: 104, right: 48, bottom: 48 },
    "margin preset reserves extra room beyond its left rail"
  );
  const trianglesPreset = await client.request("GET", `/v1/documents/organizations/${orgId}/themes/thm_triangles`);
  assert.deepEqual(
    trianglesPreset.theme.definition.page_masters.find((master: any) => master.match?.role === "*").content_inset,
    { top: 104, left: 64, right: 64, bottom: 104 },
    "triangle body pages reserve a larger safe area on every side"
  );

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/themes`, {
    id: "thm_company_defaults_test",
    name: "Company defaults",
    definition: {
      tokens: {
        colors: { primary: "#FFFFFF", accent: "#EEEEEE", text: "#111827" },
        fonts: { display: "Inter", body: "Inter" }
      },
      page_masters: [],
      type_styles: {},
      widget_skins: {}
    }
  });
  const detail = await client.request("GET", `/v1/documents/organizations/${orgId}/themes/${created.theme.id}`);
  assert.equal(detail.theme.definition.tokens.colors.primary, palette[0]);
  assert.equal(detail.theme.definition.tokens.colors.accent, palette[1]);
  assert.equal(detail.theme.definition.tokens.fonts.display, "Poppins");

  const cloned = await client.request("POST", `/v1/documents/organizations/${orgId}/themes`, {
    id: "thm_exact_clone_test",
    name: "Exact clone",
    definition: detail.theme.definition,
    use_company_defaults: false
  });
  const clonedDetail = await client.request("GET", `/v1/documents/organizations/${orgId}/themes/${cloned.theme.id}`);
  assert.deepEqual(clonedDetail.theme.definition, detail.theme.definition, "theme duplication preserves the source definition exactly");

  // Publishing edits does not re-apply Company Settings; themes remain freeform.
  const editedDefinition = structuredClone(detail.theme.definition);
  editedDefinition.tokens.colors.primary = "#ABCDEF";
  editedDefinition.tokens.fonts.display = "Lato";
  await client.request("POST", `/v1/documents/organizations/${orgId}/themes/${created.theme.id}/publish`, {
    definition: editedDefinition,
    expected_version: 1
  });
  const edited = await client.request("GET", `/v1/documents/organizations/${orgId}/themes/${created.theme.id}`);
  assert.equal(edited.theme.definition.tokens.colors.primary, "#ABCDEF");
  assert.equal(edited.theme.definition.tokens.fonts.display, "Lato");
});

test("explicit Blank opts out of a type default and resolves a word-processing scaffold", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_blank_document_test";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    template_id: null,
    workflow_id: null,
    title: "Test"
  });
  assert.equal(created.document.template_ref, null, "Blank does not silently select the proposal default template");

  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/resolve`, {});
  assert.equal(resolved.resolved_definition.settings.paper.size, "letter");
  assert.equal(resolved.resolved_definition.chains.body.auto_pages, true);
  assert.deepEqual(resolved.resolved_definition.pages[0].children.map((node: any) => node.props.page_region), ["header", "body", "footer"]);
});

test("roofing sign-and-pay template applies its percentage schedule to preview and payment", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_template_percentage_schedule";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    template_id: "tpl_roofing_signature_payment",
    title: "Percentage Schedule Agreement",
    params: {
      customer: { name: "Schedule Customer", email: "schedule@example.test" },
      scope_items: SCOPE_ITEMS,
      tax_percent: 0
    }
  });
  assert.deepEqual(
    created.document.params.payment_schedule.map((row: any) => [row.label, row.percent, row.due_rule]),
    [["Deposit", 30, "on_signature"], ["Final payment", 70, "project_completion"]],
    "the published template default is copied onto the instance"
  );

  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/resolve`, {});
  const widgets = Object.values(resolved.widget_data || {}) as any[];
  const payNow = widgets.find((value) => Number(value?.amount_due_cents || 0) > 0);
  const schedule = widgets.find((value) => Array.isArray(value?.rows) && value.rows.some((row: any) => /deposit/i.test(row.label)));
  assert.equal(payNow?.amount_due_cents, 405000, "Pay resolves the 30% deposit instead of zero");
  assert.equal(schedule?.rows.find((row: any) => /deposit/i.test(row.label))?.amount_cents, 405000);

  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/issue`, {});
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/send`, {
    recipients: [{ name: "Schedule Customer", email: "schedule@example.test", role: "customer" }]
  });
  const paid = await client.request("POST", `/v1/documents/public/${sent.snapshot.public_token}/outputs/deposit_payment`, {
    value: { payment_method: "ach", amount_cents: 0 },
    evidence: { timezone: "America/Los_Angeles", locale: "en-US" }
  });
  assert.equal(paid.snapshot.outputs.deposit_payment.amount_cents, 405000, "server charges the scheduled percentage amount");
  assert.ok(paid.snapshot.outputs.deposit_payment.payment_id, "payment produces a transaction record");
});

test("document lifecycle: create → resolve (bindings + widget data) → overrides survive republish → send → public sign/pay → locked", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_documents_test";
  await createProject(client, orgId, projectId);

  // Org branding colors: seeded themes must pick these up instead of the
  // hardcoded fallback palette (branch presentation_style layers over org
  // branding exactly like proposals/invoices).
  await client.request("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/presentation_style`, {
    data: { branding: { colors: { primary: "#C83232", secondary: "#F4B7B2" } } }
  });

  // --- create from the seeded proposal template with params -----------------
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    title: "Roof Replacement Proposal",
    params: {
      customer: { name: "Jane Homeowner", email: "jane@example.test" },
      scope_items: SCOPE_ITEMS,
      deposit_cents: 250000,
      tax_percent: 7,
      payment_schedule: [
        { label: "Deposit", amount_cents: 250000, due_rule: "at_signing" },
        { label: "Final payment", amount_cents: 1194500, due_rule: "on_completion" }
      ]
    }
  });
  const documentId = created.document.id as string;
  assert.equal(created.document.status, "draft");
  assert.equal(created.document.template_ref.template_id, "tpl_proposal_default");
  assert.deepEqual(created.missing_params, [], "required params satisfied at create");

  // --- resolve: bindings applied + repeater instances + computed totals -----
  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  const resolvedJson = JSON.stringify(resolved.resolved_definition);
  assert.ok(resolvedJson.includes("Jane Homeowner"), "customer binding resolved into the document text");
  const textRuns = collectTextRuns(resolved.resolved_definition);
  assert.ok(textRuns.length > 0, "resolved definition carries text runs");
  assert.ok(textRuns.every((text) => !text.includes("{{")), "no unresolved tokens remain in text runs");
  assert.ok(Array.isArray(resolved.resolved_definition.pages) && resolved.resolved_definition.pages.length >= 4, "proposal template has cover/pricing/signature/fine print pages");

  // The pricing page migrated from the doc.line_items widget to a repeater
  // over li_row component instances (spec §3.4). (findRepeaterFor: the
  // Project details content-blocks repeater now precedes it in page order.)
  const repeater = findRepeaterFor(resolved.resolved_definition, "li_row");
  assert.ok(repeater, "pricing page uses a repeater");
  assert.equal(repeater.children.length, 2, "one resolved instance per scope item");
  assert.equal(repeater.props.resolved_count, 2, "repeater records its resolved count");
  assert.ok(repeater.children.every((child: any) => child.component === "li_row"), "instances carry the component marker");
  assert.ok(repeater.children.every((child: any) => typeof child.repeater_index === "number"), "instances carry repeater_index");
  const instancesJson = JSON.stringify(repeater.children);
  assert.ok(instancesJson.includes("$12,500.00"), "row amount = quantity * unit_price rendered as money");
  assert.ok(instancesJson.includes("$1,000.00"), "second row amount rendered as money");
  assert.equal(repeater.props.break_rules.repeat_header, true, "repeater keeps its break rules");
  assert.ok(resolvedJson.includes("\"component\":\"li_header\""), "header resolves as a li_header component instance");
  assert.ok(resolvedJson.includes("\"component\":\"li_totals\""), "totals resolve as a li_totals component instance");

  // doc.computed totals from params.scope_items + params.tax_percent.
  const computed = resolved.resolved_definition.computed_values;
  assert.equal(computed.subtotal_cents, 1350000, "computed subtotal from enriched scope items");
  assert.equal(computed.tax_cents, Math.round(1350000 * 0.07), "computed tax");
  assert.equal(computed.total_cents, 1350000 + Math.round(1350000 * 0.07), "computed total");
  assert.ok(resolvedJson.includes("$14,445.00"), "totals component renders the computed total");

  // Widget resolvers still run for behavior widgets (payment schedule).
  const scheduleData = findWidgetRows(resolved.widget_data);
  assert.ok(scheduleData, "payment schedule widget data resolved");
  assert.ok(Object.keys(resolved.theme_vars).length > 0, "theme variables resolved");

  // Theme vars derive from org branding: primary AND secondary.
  assert.equal(resolved.theme_vars["--fm-color-primary"], "#C83232", "primary comes from org branding");
  assert.equal(resolved.theme_vars["--fm-primary"], "#C83232", "primary alias matches org branding");
  assert.equal(resolved.theme_vars["--fm-color-accent"], "#F4B7B2", "accent comes from org secondary branding");
  assert.equal(resolved.theme_vars["--fm-color-secondary"], "#F4B7B2", "secondary comes from org branding");

  // Font vars carry full fallback stacks, never bare family names.
  assert.ok(resolved.theme_vars["--fm-font-display"].includes("Montserrat"), "display font keeps its family");
  assert.ok(resolved.theme_vars["--fm-font-display"].includes(","), "display font var is a fallback stack");
  assert.ok(resolved.theme_vars["--fm-body-font"].includes(","), "body font alias is a fallback stack");

  // Cover renders real names: customer (prepared for) and org (prepared by).
  assert.ok(resolvedJson.includes("Documents Test Org"), "org name binding resolved into the cover");

  // --- instance overrides survive a template republish ----------------------
  const templateDetail = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/tpl_proposal_default`);
  const coverNodes = templateDetail.template.definition.pages[0].children as any[];
  const textNode = coverNodes.find((node) => node.type === "text");
  assert.ok(textNode, "cover page has a text node to override");
  await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${documentId}`, {
    overrides: [{ op: "node.set", node_id: textNode.id, prop: "props.blocks.0.runs.0.text", value: "OVERRIDDEN_COVER_TEXT" }]
  });
  const afterOverride = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  assert.ok(JSON.stringify(afterOverride.resolved_definition).includes("OVERRIDDEN_COVER_TEXT"), "override applies");

  await client.request("POST", `/v1/documents/organizations/${orgId}/templates/tpl_proposal_default/publish`, {
    definition: templateDetail.template.definition,
    expected_version: Number(templateDetail.template.current_version)
  });
  const afterRepublish = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  assert.ok(JSON.stringify(afterRepublish.resolved_definition).includes("OVERRIDDEN_COVER_TEXT"),
    "override survives template republish (instance stays pinned to its version)");

  // --- issue + send: snapshot + public token --------------------------------
  const issued = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/issue`, {});
  assert.equal(issued.document.status, "issued");
  assert.deepEqual(issued.missing_params, []);

  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/send`, {
    recipients: [{ name: "Jane Homeowner", email: "jane@example.test", role: "customer" }]
  });
  assert.equal(sent.document.status, "sent");
  const token = sent.snapshot.public_token as string;
  assert.ok(token, "send created a public token");
  assert.equal(sent.document.delivery.current_snapshot_id, sent.snapshot.id);
  assert.equal(sent.snapshot.locked, true, "snapshot is frozen");

  const snapshots = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/snapshots`);
  assert.equal(snapshots.count, 1);

  // --- public GET + view ----------------------------------------------------
  const publicView = await client.request("GET", `/v1/documents/public/${token}`);
  assert.equal(publicView.document.id, documentId);
  assert.equal(publicView.document.document_type, "proposal");
  assert.ok(publicView.snapshot.resolved_definition.pages.length >= 4, "public snapshot carries the frozen definition");
  assert.ok(findWidgetRows(publicView.snapshot.widget_data), "public snapshot carries frozen widget data");
  const frozenRepeater = findRepeaterFor(publicView.snapshot.resolved_definition, "li_row");
  assert.ok(frozenRepeater && frozenRepeater.children.length === 2, "frozen snapshot carries the expanded repeater instances");

  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "documents.esign": false, "documents.payments": false }
  });
  const disabledPublicView = await client.request("GET", `/v1/documents/public/${token}`);
  const disabledWidgets: string[] = [];
  walkDefinitionNodes(disabledPublicView.snapshot.resolved_definition, (node) => {
    const widget = String(node?.props?.widget || node?.props?.widget_id || "").split("@")[0];
    if (widget) disabledWidgets.push(widget);
  });
  assert.equal(disabledWidgets.includes("doc.signature"), true, "disabled e-signature widgets remain visible in existing public snapshots");
  assert.equal(disabledWidgets.includes("doc.pay_now"), true, "disabled payment widgets remain visible in existing public snapshots");
  assert.equal(Object.values(disabledPublicView.snapshot.output_defs).filter((def: any) => def?.type === "signature" || def?.type === "payment").every((def: any) => def?.disabled === true), true);
  const disabledSignature = await client.raw("POST", `/v1/documents/public/${token}/outputs/sig_customer`, {
    value: { type: "typed", text: "Jane Homeowner", signer_name: "Jane Homeowner" }
  });
  assert.equal(disabledSignature.statusCode, 403, "public signature collection stops when e-sign is disabled");
  const disabledPayment = await client.raw("POST", `/v1/documents/public/${token}/outputs/deposit_payment`, {
    value: { method: "card" }
  });
  assert.equal(disabledPayment.statusCode, 403, "public document payments stop when payments are disabled");
  const disabledPricing = await client.raw("POST", `/v1/documents/public/${token}/pricing`, { checkout: { payment_method: "card" } });
  assert.equal(disabledPricing.statusCode, 403, "document checkout pricing stops when payments are disabled");
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "documents.esign": true, "documents.payments": true }
  });

  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "customer_portal.payments": false }
  });
  const portalPaymentsOff = await client.request("GET", `/v1/documents/public/${token}`);
  assert.equal(Object.values(portalPaymentsOff.snapshot.output_defs).filter((def: any) => def?.type === "payment").every((def: any) => def?.disabled === true), true,
    "portal payment requirements remain visible but disabled while customer-portal payments are disabled");
  const portalPaymentDenied = await client.raw("POST", `/v1/documents/public/${token}/outputs/deposit_payment`, {
    value: { method: "card" }
  });
  assert.equal(portalPaymentDenied.statusCode, 403);
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "customer_portal.payments": true }
  });

  const viewed = await client.request("POST", `/v1/documents/public/${token}/view`, { session_id: "sess_1" });
  assert.equal(viewed.document.status, "viewed");

  // --- signature output → signed (not completed: deposit gate) --------------
  const signedResult = await client.request("POST", `/v1/documents/public/${token}/outputs/sig_customer`, {
    value: { type: "typed", text: "Jane Homeowner", signer_name: "Jane Homeowner", style: "style-classic" },
    evidence: { timezone: "America/Los_Angeles", locale: "en-US" }
  });
  assert.equal(signedResult.document.status, "signed", "signature satisfies the required signature output");

  const afterSign = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}`);
  assert.equal(afterSign.document.status, "signed");
  assert.ok(afterSign.document.outputs.sig_customer.signed_at, "signature value records signed_at");
  assert.ok(afterSign.document.outputs.sig_customer.evidence, "signature value records evidence");

  // unknown output key is rejected
  const unknownOutput = await client.raw("POST", `/v1/documents/public/${token}/outputs/not_a_real_output`, { value: 1 });
  assert.equal(unknownOutput.statusCode, 400);

  // --- required-output gating: completed only after the payment output ------
  const events1 = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/events`);
  const types1 = events1.events.map((event: any) => event.type);
  assert.ok(types1.includes("document.sent"), "document.sent event appended");
  assert.ok(types1.includes("document.viewed"), "document.viewed event appended");
  assert.ok(types1.includes("document.output.recorded"), "output.recorded event appended");
  assert.ok(types1.includes("document.signed"), "document.signed event appended");
  assert.ok(!types1.includes("document.completed"), "not completed before the deposit payment output");

  const intentOnlyPayment = await client.raw("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/outputs/deposit_payment`, {
    value: { intent: "pay", amount_cents: 250000 }
  });
  assert.equal(intentOnlyPayment.statusCode, 400, "opening checkout does not count as a completed payment");

  const paid = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/outputs/deposit_payment`, {
    value: { amount_cents: 250000, method: "mock", reference: "pay_test_1" }
  });
  assert.equal(paid.status, "completed", "payment output completes the document");

  const events2 = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/events`);
  const types2 = events2.events.map((event: any) => event.type);
  assert.ok(types2.includes("document.payment.received"), "payment.received event appended");
  assert.ok(types2.includes("document.completed"), "document.completed event appended");

  // --- signed/completed instances are locked --------------------------------
  const lockedPatch = await client.raw("PATCH", `/v1/documents/organizations/${orgId}/documents/${documentId}`, {
    title: "Sneaky edit"
  });
  assert.equal(lockedPatch.statusCode, 409, "PATCH on a signed document is rejected");
  assert.equal(JSON.parse(lockedPatch.body).error, "document_locked_signed");

  // explicit void is still allowed on a locked document
  const voided = await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${documentId}`, {
    status: "void"
  });
  assert.equal(voided.document.status, "void");
});

test("documents without a required template param stay draft with missing_params", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_missing_params";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    title: "Empty Proposal"
  });
  assert.ok(created.missing_params.includes("scope_items"), "scope_items reported missing");

  const issued = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/issue`, {});
  assert.ok(issued.missing_params.includes("scope_items"), "issue reports missing params");
  assert.equal(issued.document.status, "draft", "status stays draft until required params resolve");

  // No explicit params.customer: the cover binding falls back to the primary
  // project contact through the top-level customer scope entity.
  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/resolve`, {});
  assert.ok(JSON.stringify(resolved.resolved_definition).includes("Jane Homeowner"),
    "prepared-for binding falls back to the project contact name");
});

test("ingest stores the upload and creates a needs_review instance with extraction stubbed", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_ingest";
  await createProject(client, orgId, projectId);

  const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "ascii");
  const ingested = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/ingest`, {
    file_name: "signed-proposal-2024.pdf",
    content_type: "application/pdf",
    data_base64: pdfBytes.toString("base64"),
    project_id: projectId
  });
  assert.equal(ingested.document.status, "needs_review");
  assert.equal(ingested.document.source, "uploaded");
  assert.equal(ingested.document.document_type, "proposal", "file-name heuristic classified the type");
  assert.ok(ingested.media_id, "upload landed in the media store");
  assert.ok(ingested.document.ingestion.media_id, "instance references the stored media");

  const events = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${ingested.document.id}/events`);
  assert.ok(events.events.some((event: any) => event.type === "document.ingested"), "document.ingested event appended");
});

test("render harness HTML inlines the three libraries and the frozen payload (no browser launched)", async () => {
  const { buildRenderHarnessHtml } = await import("../documents/render.js");
  const { FMDocModel } = await import("../documents/schemas.js");
  const definition = FMDocModel.createDocument({ first_page_role: "body" });
  const html = await buildRenderHarnessHtml({
    resolved_definition: definition as any,
    theme: { tokens: { colors: { primary: "#2563EB" } } },
    themeContext: { branding: {}, overrides: {} },
    widgetData: { node_test: { rows: [] } },
    scope: { params: { marker_param: "HARNESS_MARKER_VALUE" }, outputs: {} },
    title: "Harness Test"
  });
  assert.ok(html.startsWith("<!doctype html>"), "harness is a complete html document");
  assert.ok(html.includes("FMDocModel"), "doc-model library inlined");
  assert.ok(html.includes("FMDocRenderer.render"), "renderer boot call present");
  assert.ok(html.includes("FMDocWidgets"), "doc-widgets library inlined");
  assert.ok(html.includes("fmdoc-payload"), "payload script tag present");
  assert.ok(html.includes("HARNESS_MARKER_VALUE"), "scope payload injected as JSON");
  assert.ok(html.includes("__fmdocReady"), "readiness flag wiring present");
  assert.ok(html.includes("@page"), "print page size rule present");
  assert.ok(!html.includes("</script>Z"), "inline scripts are escaped safely");
});

test("workflow assets: create/publish with kind+writes validation, versioning, publish conflict", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);

  const definition = {
    schema_version: 1,
    name: "Intake test",
    contract: {
      params: { crew_notes: { type: "text" } },
      outputs: { sig: { type: "signature", required: true } }
    },
    steps: [
      {
        id: "st_one",
        title: "Notes",
        items: [{ kind: "text", writes: "params.crew_notes", label: "Crew notes" }]
      },
      {
        id: "st_sign",
        title: "Sign",
        audience: ["internal", "customer"],
        items: [{ kind: "signature", writes: "outputs.sig" }]
      }
    ],
    audiences: { internal: {}, customer: {} }
  };

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/workflows`, {
    id: "wfl_custom_test",
    name: "Intake test",
    definition
  });
  assert.equal(created.workflow.id, "wfl_custom_test");
  assert.equal(Number(created.workflow.current_version), 1, "create with definition publishes v1");

  // unknown item kind is rejected at publish validation
  const badKind = await client.raw("POST", `/v1/documents/organizations/${orgId}/workflows/wfl_custom_test/publish`, {
    definition: { ...definition, steps: [{ id: "st_bad", items: [{ kind: "not_a_kind", writes: "params.crew_notes" }] }] },
    expected_version: 1
  });
  assert.equal(badKind.statusCode, 400, "unknown item kind rejected");
  assert.ok(JSON.stringify(JSON.parse(badKind.body).issues).includes("Unknown workflow item kind"), "validation names the bad kind");

  // signature items may only write outputs.*
  const badWrites = await client.raw("POST", `/v1/documents/organizations/${orgId}/workflows/wfl_custom_test/publish`, {
    definition: { ...definition, steps: [{ id: "st_bad", items: [{ kind: "signature", writes: "params.crew_notes" }] }] },
    expected_version: 1
  });
  assert.equal(badWrites.statusCode, 400, "signature writing params.* rejected");

  // writes must target declared contract keys
  const undeclared = await client.raw("POST", `/v1/documents/organizations/${orgId}/workflows/wfl_custom_test/publish`, {
    definition: { ...definition, steps: [{ id: "st_bad", items: [{ kind: "text", writes: "params.not_declared" }] }] },
    expected_version: 1
  });
  assert.equal(undeclared.statusCode, 400, "undeclared contract param rejected");

  const republished = await client.request("POST", `/v1/documents/organizations/${orgId}/workflows/wfl_custom_test/publish`, {
    definition,
    expected_version: 1
  });
  assert.equal(Number(republished.workflow.current_version), 2, "publish bumps current_version");

  const versions = await client.request("GET", `/v1/documents/organizations/${orgId}/workflows/wfl_custom_test/versions`);
  assert.equal(versions.count, 2, "immutable versions listed");
  assert.ok(versions.versions.every((version: any) => version.checksum), "versions carry checksums");

  const conflictResponse = await client.raw("POST", `/v1/documents/organizations/${orgId}/workflows/wfl_custom_test/publish`, {
    definition,
    expected_version: 1
  });
  assert.equal(conflictResponse.statusCode, 409, "stale expected_version publish is rejected");

  const detail = await client.request("GET", `/v1/documents/organizations/${orgId}/workflows/wfl_custom_test`);
  assert.equal(detail.workflow.definition.name, "Intake test", "workflow detail returns the current definition");
});

test("instances attach the default workflow; workflow routes serve state and audience-filtered public views", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_workflow_test";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    title: "Workflow Proposal",
    params: {
      customer: { name: "Jane Homeowner", email: "jane@example.test" },
      scope_items: SCOPE_ITEMS,
      tax_percent: 7
    }
  });
  const documentId = created.document.id as string;
  assert.equal(created.document.workflow_ref.workflow_id, "wfl_roofing_proposal_intake", "seeded workflow attached by default");
  assert.ok(Number(created.document.workflow_ref.version) >= 1, "workflow version pinned at creation");
  assert.equal(created.document.workflow_state.current_step, "st_what", "state starts at the first step");
  assert.deepEqual(created.document.workflow_state.completed_steps, []);

  // Internal workflow view: definition + state + contract + resolved sources.
  const detail = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/workflow`);
  assert.equal(detail.workflow.name, "Roofing proposal intake");
  assert.deepEqual(detail.workflow.steps.map((step: any) => step.id), ["st_what", "st_measure", "st_items", "st_details", "st_options", "st_review"]);
  assert.deepEqual(
    detail.workflow.steps.map((step: any) => (step.items || []).map((item: any) => item.kind)),
    [["piece_select"], ["measurements"], ["line_items_review"], ["content_blocks"], ["choice_group"], ["review"]],
    "native step kinds: piece_select → measurements → line_items_review → content_blocks → choice_group → review"
  );
  assert.ok(detail.contract.params.scope_items, "contract params exposed");
  assert.ok(detail.contract.params.scope_pieces, "contract declares the piece selection param");
  assert.ok(detail.contract.outputs.sig_customer, "contract outputs exposed");
  assert.equal(detail.state.current_step, "st_what");
  assert.ok(detail.sources && typeof detail.sources === "object", "workflow sources resolved server-side");
  // st_options derives its choices from params.scope_items now (options_from
  // "scope_items"), not a detached pricebook-category source — no source rows
  // are expected for it.
  const optionsStep = detail.workflow.steps.find((step: any) => step.id === "st_options");
  assert.equal(optionsStep.items[0].options_from, "scope_items", "customer options derive from the scope's choice groups");

  // State updates: complete a step (advances), jump explicitly, reject unknown.
  const advanced = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/workflow/state`, {
    complete_step: "st_what"
  });
  assert.equal(advanced.state.current_step, "st_measure", "completing a step advances to the next");
  assert.deepEqual(advanced.state.completed_steps, ["st_what"]);
  const jumped = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/workflow/state`, {
    current_step: "st_review"
  });
  assert.equal(jumped.state.current_step, "st_review");
  const badStep = await client.raw("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/workflow/state`, {
    current_step: "st_nope"
  });
  assert.equal(badStep.statusCode, 400, "unknown step id rejected");

  // Workflow writes flow through the existing PATCH params route (no second write path).
  await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${documentId}`, {
    params: { measurements: { roofSquares: 24 } }
  });
  const afterWrite = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}`);
  assert.equal(afterWrite.document.params.measurements.roofSquares, 24, "workflow item writes land on instance params");

  // Public: customer audience only sees options + review (st_what/st_measure/
  // st_items are internal AND hidden via audiences.customer.hide_steps).
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/send`, {
    recipients: [{ name: "Jane Homeowner", email: "jane@example.test" }]
  });
  const token = sent.snapshot.public_token as string;
  const publicWorkflow = await client.request("GET", `/v1/documents/public/${token}/workflow`);
  assert.deepEqual(publicWorkflow.workflow.steps.map((step: any) => step.id), ["st_options", "st_review"], "internal steps filtered for the portal wizard");
  assert.equal(publicWorkflow.document.id, documentId);
  assert.ok(publicWorkflow.state, "public view includes navigation state");
  assert.equal(publicWorkflow.params.measurements.roofSquares, 24, "public workflow includes bound params for data-driven choices");
  assert.deepEqual(publicWorkflow.outputs, {}, "public workflow includes resumable output state");
  assert.ok(!JSON.stringify(publicWorkflow.workflow.audiences).includes("hide_steps") || !publicWorkflow.workflow.audiences.internal, "internal audience config not leaked");

  // Documents without a workflow 404 on the public workflow route.
  const plain = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "generic",
    title: "Plain Doc"
  });
  const plainSent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${plain.document.id}/send`, {});
  const noWorkflow = await client.raw("GET", `/v1/documents/public/${plainSent.snapshot.public_token}/workflow`);
  assert.equal(noWorkflow.statusCode, 404, "no workflow -> 404-style ok:false");
  assert.equal(JSON.parse(noWorkflow.body).ok, false);
});

test("conditional pricing: checkout-driven rows, formula fees, discounts, days_since gating, public pricing preview, and authoritative payment amounts", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_conditional_pricing";
  await createProject(client, orgId, projectId);

  const BASE_SUBTOTAL = 1350000; // SCOPE_ITEMS: 12500.00 + 2 * 500.00 dollars
  const conditionalItems = [
    ...SCOPE_ITEMS,
    {
      id: "item_card_fee",
      name: "Card processing fee",
      condition: 'checkout.payment_method == "card"',
      pricing: { formula: "round(rows_subtotal_cents * checkout.processing_fee_percent / 100)" },
      badge: "Card payments only",
      quantity: 1,
      unit: "ea",
      unit_price: 0
    },
    {
      id: "item_ach_discount",
      name: "ACH discount",
      condition: 'checkout.payment_method == "ach"',
      pricing: { formula: "0 - round(rows_subtotal_cents * 2 / 100)" },
      discount: true
    },
    {
      id: "item_early_discount",
      name: "Early signing discount",
      condition: "days_since(doc.sent_at) < 7",
      quantity: 1,
      unit: "ea",
      unit_price: -500,
      badge: "Sign within 7 days",
      discount: true
    }
  ];

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    title: "Conditional Pricing Proposal",
    params: {
      customer: { name: "Jane Homeowner", email: "jane@example.test" },
      scope_items: conditionalItems,
      deposit_cents: 100000,
      tax_percent: 0,
      // Opt out of the seeded default pricing_adjustments so this test stays
      // focused on IN-SCOPE conditional rows (the defaults have their own test).
      pricing_adjustments: []
    }
  });
  const documentId = created.document.id as string;

  // --- no checkout: every conditional row excluded, base subtotal only ------
  const plain = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  assert.equal(plain.resolved_definition.computed_values.subtotal_cents, BASE_SUBTOTAL, "conditional rows excluded without checkout/sent_at");
  assert.equal(plain.scope.checkout.payment_method, null, "checkout defaults to no payment method");
  assert.equal(plain.scope.checkout.processing_fee_percent, 3, "processing fee percent defaults to 3");
  const plainConditional = plain.scope.params.conditional_rows as any[];
  assert.equal(plainConditional.length, 3, "all condition-bearing rows are inventoried");
  assert.ok(plainConditional.every((row) => row.included === false), "every conditional row evaluates excluded");
  assert.ok(plainConditional.every((row) => typeof row.condition === "string" && row.condition.length > 0), "conditional rows keep their expressions for client re-evaluation");
  assert.equal((plain.scope.params.scope_rows as any[]).length, 2, "flat projection drops excluded conditional rows");
  const earlyRow = plainConditional.find((row) => row.id === "item_early_discount");
  assert.equal(earlyRow.badge, "Sign within 7 days", "badge survives enrichment");
  assert.equal(earlyRow.discount, true, "discount flag survives enrichment");

  // --- card checkout: 3% fee formula row included, computed cents exact -----
  const card = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {
    checkout: { payment_method: "card" }
  });
  const cardFeeCents = Math.round(BASE_SUBTOTAL * 3 / 100);
  assert.equal(card.resolved_definition.computed_values.subtotal_cents, BASE_SUBTOTAL + cardFeeCents, "card fee lands in the computed subtotal");
  const cardRows = card.scope.params.scope_rows as any[];
  const cardFeeRow = cardRows.find((row) => row.id === "item_card_fee");
  assert.ok(cardFeeRow, "card fee row appears in the flat projection");
  assert.equal(cardFeeRow.amount_cents, cardFeeCents, "formula result is cents (3% of the base subtotal)");
  assert.equal(cardFeeRow.condition_met, true, "included conditional rows are marked condition_met");
  assert.ok(!cardRows.some((row) => row.id === "item_ach_discount"), "ach discount stays excluded under card");

  // --- ach checkout: negative formula row reduces the computed total --------
  const ach = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {
    checkout: { payment_method: "ach" }
  });
  const achDiscountCents = -Math.round(BASE_SUBTOTAL * 2 / 100);
  assert.equal(ach.resolved_definition.computed_values.subtotal_cents, BASE_SUBTOTAL + achDiscountCents, "negative ACH row reduces the computed subtotal");
  assert.ok(ach.resolved_definition.computed_values.subtotal_cents < BASE_SUBTOTAL, "ach total is below the base subtotal");
  const achRow = (ach.scope.params.scope_rows as any[]).find((row) => row.id === "item_ach_discount");
  assert.equal(achRow.amount_cents, achDiscountCents, "discount amount is negative cents");

  // --- send: doc.sent_at set, days_since gating flips the early discount ----
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/send`, {
    recipients: [{ name: "Jane Homeowner", email: "jane@example.test" }]
  });
  const token = sent.snapshot.public_token as string;
  const afterSend = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  assert.ok(afterSend.scope.doc.sent_at, "doc scope carries delivery.sent_at");
  const earlyDiscountCents = -50000; // 1 * -$500
  assert.equal(afterSend.resolved_definition.computed_values.subtotal_cents, BASE_SUBTOTAL + earlyDiscountCents,
    "days_since(doc.sent_at) < 7 includes the early-signing discount after send");

  // --- public pricing preview: authoritative retotaling per payment method --
  const previewCard = await client.request("POST", `/v1/documents/public/${token}/pricing`, {
    checkout: { payment_method: "card" }
  });
  assert.equal(previewCard.totals.total_cents, BASE_SUBTOTAL + earlyDiscountCents + cardFeeCents, "card preview retotals with fee + early discount");
  assert.ok((previewCard.rows as any[]).some((row) => row.id === "item_card_fee"), "card preview rows include the fee");
  assert.equal((previewCard.conditional_rows as any[]).length, 3, "preview returns the conditional inventory");
  const previewAch = await client.request("POST", `/v1/documents/public/${token}/pricing`, {
    checkout: { payment_method: "ach" }
  });
  assert.equal(previewAch.totals.total_cents, BASE_SUBTOTAL + earlyDiscountCents + achDiscountCents, "ach preview retotals with the discounts");
  assert.notEqual(previewCard.totals.total_cents, previewAch.totals.total_cents, "card and ach previews produce different totals");
  assert.equal(previewCard.totals.base_subtotal_cents, BASE_SUBTOTAL, "base subtotal excludes every conditional row");

  // --- mock payment path: amount recomputed server-side, never trusted ------
  await client.request("POST", `/v1/documents/public/${token}/outputs/deposit_payment`, {
    value: { amount_cents: 1, payment_method: "card", reference: "pay_conditional_1" }
  });
  const afterPay = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}`);
  assert.equal(afterPay.document.outputs.deposit_payment.amount_cents, 100000,
    "payment amount is the server-computed deposit, not the client-sent cents");
  assert.ok(afterPay.document.outputs.deposit_payment.pricing_totals, "payment records the evaluated pricing totals");
  assert.equal(afterPay.document.outputs.deposit_payment.checkout.payment_method, "card", "payment records the evaluated checkout state");
});

test("option groups: per-option enrichment (rows + total_cents) and option_choice solidifies params.scope_items", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_option_groups";
  await createProject(client, orgId, projectId);

  const { FMDocModel } = await import("../documents/schemas.js");
  const definition = FMDocModel.createDocument({ first_page_role: "body" }) as any;
  definition.params = {
    proposal_options: { type: "list", label: "Proposal options" },
    scope_items: { type: "list", label: "Line items" }
  };
  definition.outputs = { option_choice: { type: "select", required_for: "signed" } };
  await client.request("POST", `/v1/documents/organizations/${orgId}/templates`, {
    id: "tpl_option_groups_test",
    name: "Option Groups Test",
    document_type: "generic",
    definition
  });

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "generic",
    template_id: "tpl_option_groups_test",
    title: "Good/Best Proposal",
    params: {
      proposal_options: [
        {
          id: "opt_good",
          label: "Good",
          summary: "Architectural shingles",
          items: [{ id: "item_good_roof", name: "Good roof", quantity: 1, unit: "job", unit_price: 10000 }]
        },
        {
          id: "opt_best",
          label: "Best",
          summary: "Designer shingles + ridge vent",
          items: [
            { id: "item_best_roof", name: "Best roof", quantity: 1, unit: "job", unit_price: 15000 },
            { id: "item_ridge_vent", name: "Ridge vent", quantity: 1, unit: "ea", unit_price: 500 }
          ]
        }
      ]
    }
  });
  const documentId = created.document.id as string;

  // --- enrichment: per-option rows + total_cents on the SAME param ----------
  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  const options = resolved.scope.params.proposal_options as any[];
  assert.equal(options.length, 2, "both options survive enrichment");
  assert.equal(options[0].total_cents, 1000000, "good option total (cents)");
  assert.equal(options[1].total_cents, 1550000, "best option total (cents)");
  assert.equal(options[0].rows.length, 1, "good option flat projection");
  assert.equal(options[1].rows.length, 2, "best option flat projection");
  assert.equal(options[1].items[0].amount_cents, 1500000, "option items are enriched like scope_items");
  assert.equal(options[1].id, "opt_best", "option identity intact");

  // --- option_choice recording derives params.scope_items -------------------
  const recorded = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/outputs/option_choice`, {
    value: "opt_best"
  });
  assert.ok(recorded.document, "output recorded");
  const after = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}`);
  assert.equal(after.document.outputs.option_choice, "opt_best", "choice stored on outputs");
  const solidified = after.document.params.scope_items as any[];
  assert.equal(solidified.length, 2, "scope_items derived from the chosen option");
  assert.equal(solidified[0].name, "Best roof", "chosen option items become the document scope");
  assert.equal((after.document.params.proposal_options as any[]).length, 2, "original options stay intact");
  const events = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/events`);
  const outputEvent = events.events.find((event: any) => event.type === "document.output.recorded" && event.payload?.output_key === "option_choice");
  assert.ok(outputEvent, "output.recorded event appended");
  assert.equal(outputEvent.payload.option_id, "opt_best", "event records the solidified option");

  // Post-solidify resolution prices the derived scope_items.
  const afterResolve = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  assert.equal((afterResolve.scope.params.scope_rows as any[]).length, 2, "derived scope_items get the flat projection");
});

test("workflow kind content_blocks: params-only registration accepted at publish", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);

  const definition = {
    schema_version: 1,
    name: "Content blocks intake",
    contract: {
      params: { content_blocks: { type: "list" } },
      outputs: {}
    },
    steps: [
      {
        id: "st_content",
        title: "Project details",
        items: [{ kind: "content_blocks", writes: "params.content_blocks", label: "Content blocks" }]
      }
    ],
    audiences: { internal: {} }
  };
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/workflows`, {
    id: "wfl_content_blocks_test",
    name: "Content blocks intake",
    definition
  });
  assert.equal(Number(created.workflow.current_version), 1, "content_blocks workflow publishes");

  // content_blocks is params-only: outputs.* writes are rejected.
  const badWrites = await client.raw("POST", `/v1/documents/organizations/${orgId}/workflows/wfl_content_blocks_test/publish`, {
    definition: {
      ...definition,
      contract: { params: { content_blocks: { type: "list" } }, outputs: { sig: { type: "signature" } } },
      steps: [{ id: "st_bad", items: [{ kind: "content_blocks", writes: "outputs.sig" }] }]
    },
    expected_version: 1
  });
  assert.equal(badWrites.statusCode, 400, "content_blocks writing outputs.* rejected");
});

test("source registry: repeaters over 'source:<id>' resolve rows server-side and freeze into params.__sources", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_sources_test";
  await createProject(client, orgId, projectId);

  const { registerDocumentSource } = await import("../documents/sources/registry.js");
  registerDocumentSource("test.rows", {
    shape: { rows: ["label", "amount_cents"] },
    resolve: async () => [
      { label: "Row A", amount_cents: 12345 },
      { label: "Row B", amount_cents: 500 }
    ]
  });

  const { FMDocModel } = await import("../documents/schemas.js");
  const definition = FMDocModel.createDocument({ first_page_role: "body" }) as any;
  definition.components = {
    srow: {
      params: { item: { type: "pricebook_line" } },
      root: {
        id: "cmp_srow_root",
        type: "text",
        frame: { x: 0, y: 0, w: 400, h: 20 },
        props: {
          blocks: [{
            id: "cmp_srow_blk",
            type: "paragraph",
            align: "left",
            runs: [
              { text: "", bind: "item.label" },
              { text: "  " },
              { text: "", bind: "item.amount_cents | money" }
            ]
          }]
        }
      }
    }
  };
  definition.pages[0].children = [
    {
      id: "nd_source_repeater",
      type: "repeater",
      frame: { x: 40, y: 40, w: 400, h: 400 },
      props: {
        source: "source:test.rows",
        component: "srow",
        as: "row",
        layout: { direction: "column", columns: 1, gap_pt: 4 }
      }
    }
  ];

  await client.request("POST", `/v1/documents/organizations/${orgId}/templates`, {
    id: "tpl_source_test",
    name: "Source Test",
    document_type: "generic",
    definition
  });
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "generic",
    template_id: "tpl_source_test",
    title: "Source Doc"
  });

  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/resolve`, {});
  assert.ok(Array.isArray(resolved.sources["test.rows"]), "resolve response exposes the resolved source rows");
  assert.equal(resolved.sources["test.rows"].length, 2);
  const repeater = findNodeByType(resolved.resolved_definition, "repeater");
  assert.ok(repeater, "repeater survives resolution");
  assert.equal(repeater.props.source, "{{params.__sources['test.rows']}}", "source sugar rewritten to the scope expression");
  assert.equal(repeater.children.length, 2, "one component instance per source row");
  const instancesJson = JSON.stringify(repeater.children);
  assert.ok(instancesJson.includes("Row A") && instancesJson.includes("Row B"), "rows bound into component instances");
  assert.ok(instancesJson.includes("$123.45"), "source row money formatted");

  // Snapshots freeze the resolved rows like widget data.
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/send`, {});
  assert.ok(Array.isArray(sent.snapshot.sources["test.rows"]), "snapshot freezes resolved sources");
  const frozen = findNodeByType(sent.snapshot.resolved_definition, "repeater");
  assert.equal(frozen.children.length, 2, "frozen definition carries the expanded instances");
});

test("showcase seeds: legal, proposal, and completion templates validate; workflows republish through kind validation", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await client.request("GET", `/v1/documents/organizations/${orgId}/templates`); // lazy-seed

  const { FMDocModel } = await import("../documents/schemas.js");
  const legal = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/tpl_one_page_legal`);
  assert.equal(legal.template.document_type, "contract");
  assert.equal(legal.template.definition.settings.paper.size, "legal", "one-page agreement uses legal paper");
  assert.equal(legal.template.definition.pages.length, 1, "one-page agreement is a single page (all absolute nodes)");
  assert.ok(FMDocModel.validateDocument(legal.template.definition).ok, "legal template validates");
  assert.equal(legal.template.metadata.default_workflow_id, "wfl_one_page_legal", "legal template pins its fill workflow");

  const threeOpt = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/tpl_three_option_proposal`);
  assert.equal(threeOpt.template.document_type, "proposal");
  assert.ok(FMDocModel.validateDocument(threeOpt.template.definition).ok, "three-option template validates");
  const detailPage = threeOpt.template.definition.pages.find((page: any) => page.repeat?.for);
  assert.ok(detailPage, "three-option template page-repeats over the options");
  assert.equal(detailPage.repeat.as, "option");

  const hybrid = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/tpl_roofing_selection_to_document`);
  assert.equal(hybrid.template.metadata.customer_presentation.mode, "hybrid");
  assert.equal(hybrid.template.metadata.customer_presentation.tab.id, "proposals");
  const signPay = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/tpl_roofing_signature_payment`);
  assert.equal(signPay.template.metadata.disable_default_workflow, true);
  assert.equal(signPay.template.metadata.customer_presentation.mode, "document");
  const documentOnly = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/tpl_roofing_good_better_best_document`);
  assert.equal(documentOnly.template.metadata.customer_presentation.mode, "document");
  assert.equal(documentOnly.template.metadata.disable_default_workflow, true);
  const workflowOnly = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/tpl_roofing_good_better_best_workflow`);
  assert.equal(workflowOnly.template.metadata.customer_presentation.mode, "workflow");
  assert.equal(workflowOnly.template.metadata.default_workflow_id, "wfl_roofing_customer_workflow");
  const completion = await client.request("GET", `/v1/documents/organizations/${orgId}/templates/tpl_roofing_completion_certificate`);
  assert.equal(completion.template.document_type, "completion_certificate");
  assert.equal(completion.template.metadata.customer_presentation.tab.id, "sign_off");
  assert.equal(completion.template.metadata.customer_presentation.mode, "document");
  assert.equal(completion.template.metadata.disable_default_workflow, true);
  assert.ok(FMDocModel.validateDocument(completion.template.definition).ok, "completion certificate validates");
  assert.ok(completion.template.definition.pages[0].children.length >= 8, "completion certificate seed contains its certificate content");
  assert.ok(JSON.stringify(completion.template.definition).includes("params.final_payment_cents"), "completion pay-now card binds the final balance");

  // Republishing the seeded workflow definitions through the API proves every
  // step item passes the registered kind + writes validation.
  for (const id of ["wfl_one_page_legal", "wfl_three_option_proposal", "wfl_roofing_completion_signoff", "wfl_roofing_customer_workflow"]) {
    const detail = await client.request("GET", `/v1/documents/organizations/${orgId}/workflows/${id}`);
    assert.ok(Number(detail.workflow.current_version) >= 1, `${id} published at seed time`);
    const republished = await client.request("POST", `/v1/documents/organizations/${orgId}/workflows/${id}/publish`, {
      definition: detail.workflow.definition,
      expected_version: Number(detail.workflow.current_version)
    });
    assert.equal(Number(republished.workflow.current_version), Number(detail.workflow.current_version) + 1, `${id} republishes cleanly (kinds + writes validate)`);
  }
});

test("one-page legal agreement: params-driven checkbox glyphs, computed price panel, exactly one resolved page", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_one_page_legal";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "contract",
    title: "Roofing Agreement",
    params: {
      customer: { name: "Jane Homeowner", email: "jane@example.test" },
      agreement_date: "2026-07-27",
      customer_info: {
        name: "Jane Homeowner",
        phone: "(555) 111-2222",
        email: "jane@example.test",
        owner_address: "100 Document Lane",
        city: "Lakeville",
        state: "MN",
        zip: "55044",
        project_address: "100 Document Lane, Lakeville MN"
      },
      spec: {
        tear_off: true,
        tear_shingles: true,
        tear_off_layers: 2,
        haul_debris: true,
        renail_deck: true,
        underlayment: "synthetic",
        ice_water_shield: true,
        ridge_vent: true,
        install_shingle_system: true,
        gutters_5in: true
      },
      materials: {
        manufacturer: "GAF",
        product: "Timberline HDZ",
        color: "Charcoal",
        warranty_tier: "premium",
        labor_years: 10,
        manufacturer_years: 50
      },
      pricing: { contract_price_cents: 2485000, tax_code: "MN", tax_rate_percent: 7.375, amount_paid_cents: 500000 },
      notes: "Deliver materials to the driveway; dog in the backyard.",
      representative: "Alex Representative"
    }
  });
  const documentId = created.document.id as string;
  assert.equal(created.document.template_ref.template_id, "tpl_one_page_legal", "contract type defaults to the one-page legal template");
  assert.equal(created.document.workflow_ref.workflow_id, "wfl_one_page_legal", "fill workflow attached via template metadata");

  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  assert.equal(resolved.resolved_definition.pages.length, 1, "agreement resolves to exactly one page");
  const runs = collectTextRuns(resolved.resolved_definition).join("\n");
  assert.ok(runs.includes("☑"), "checked spec boxes render the checked glyph");
  assert.ok(runs.includes("☐"), "unchecked spec boxes render the empty glyph");
  const blocks = collectBlockTexts(resolved.resolved_definition);
  assert.ok(blocks.some((text) => text.includes("☑ Synthetic") && text.includes("☐ Safeguard")),
    "select-driven underlayment sub-checkboxes check only the chosen value");
  assert.ok(runs.includes("GAF"), "materials bind into the agreement");
  const computed = resolved.resolved_definition.computed_values;
  assert.equal(computed.contract_tax_cents, Math.round(2485000 * 7.375 / 100), "sales tax computed from rate");
  assert.equal(computed.contract_total_cents, 2485000 + computed.contract_tax_cents, "total = price + tax");
  assert.equal(computed.balance_due_cents, computed.contract_total_cents - 500000, "balance due nets the amount paid");
  assert.ok(JSON.stringify(resolved.resolved_definition).includes("Jane Homeowner"), "customer info binds into the form fields");
});

test("one-page legal workflow starts with the native scope steps (piece_select → measurements → line_items_review)", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await client.request("GET", `/v1/documents/organizations/${orgId}/templates`); // lazy-seed

  const detail = await client.request("GET", `/v1/documents/organizations/${orgId}/workflows/wfl_one_page_legal`);
  const definition = detail.workflow.definition;
  assert.deepEqual(
    definition.steps.map((step: any) => step.id),
    ["st_what", "st_measure", "st_items", "st_customer", "st_specs", "st_materials", "st_pricing", "st_notes", "st_review"],
    "legal workflow leads with the roofing-intake scope steps"
  );
  assert.deepEqual(
    definition.steps.slice(0, 3).map((step: any) => (step.items || []).map((item: any) => item.kind)),
    [["piece_select"], ["measurements"], ["line_items_review"]],
    "scope steps use the native kinds"
  );
  assert.equal(definition.steps[1].auto_skip_when_complete, true, "measurements auto-skip when satisfied");
  assert.ok(definition.contract.params.scope_items, "contract declares scope_items");
  assert.ok(definition.contract.params.scope_pieces, "contract declares scope_pieces");
  assert.ok(definition.contract.params.measurement_requirements, "contract declares measurement_requirements");
  const specStep = definition.steps.find((step: any) => step.id === "st_specs");
  assert.ok(String(specStep.description || "").includes("auto-derive"), "spec step explains checkboxes derive from the scope");
  const priceItem = definition.steps.find((step: any) => step.id === "st_pricing").items[0];
  assert.notEqual(priceItem.required, true, "contract price is an optional override now");
  assert.ok(
    definition.audiences.customer.hide_steps.includes("st_what") && definition.audiences.customer.hide_steps.includes("st_items"),
    "scope steps hidden from the customer audience"
  );

  // The contract doc attaches this workflow and starts at the scope step.
  const projectId = "project_legal_scope_steps";
  await createProject(client, orgId, projectId);
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "contract",
    title: "Scope-driven Agreement"
  });
  assert.equal(created.document.workflow_ref.workflow_id, "wfl_one_page_legal");
  assert.equal(created.document.workflow_state.current_step, "st_what", "fill starts at the piece selection step");
});

// Scope tree shaped like the org-generated roofing assembly (pricebook_ref
// ids + choice-selection rows) — drives spec_derived + the price fallback.
const CONTRACT_SCOPE_TREE = [{
  id: "scope_roof",
  name: "Roof Replacement",
  description: "Complete sloped roof replacement scope assembled from reusable price book items.",
  quantity: 1,
  unit: "ea",
  unit_price: 0,
  children: [
    { id: "row_tearoff", pricebook_ref: { item_id: "tearoff" }, name: "Remove Existing Roofing", description: "Tear-off and disposal of existing roofing", quantity: 20, unit: "sq", unit_price: 85, included: true },
    { id: "row_ridge_vent", pricebook_ref: { item_id: "ridge_vent" }, name: "Ridge Vent", quantity: 40, unit: "lf", unit_price: 12, included: true },
    { id: "row_tiger_paw", pricebook_ref: { item_id: "gaf_tiger_paw" }, name: "GAF Tiger Paw", description: "Premium synthetic underlayment", quantity: 20, unit: "sq", unit_price: 30, included: true },
    { id: "row_shingle", pricebook_ref: { item_id: "gaf_hd" }, name: "GAF HDZ", description: "Architectural laminate shingle", quantity: 20, unit: "sq", unit_price: 398 },
    { id: "row_gutter", pricebook_ref: { item_id: "gutter_replace" }, name: "K-Style Gutter", quantity: 100, unit: "lf", unit_price: 9 }
  ]
}];

test("one-page legal agreement derives spec checkboxes and contract price from the scope tree", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_legal_spec_derived";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "contract",
    title: "Derived Agreement",
    params: {
      customer: { name: "Jane Homeowner", email: "jane@example.test" },
      scope_items: CONTRACT_SCOPE_TREE,
      // NO pricing.contract_price_cents — the price panel must fall back to
      // the scope-computed total.
      pricing: { tax_rate_percent: 0 }
    }
  });
  const documentId = created.document.id as string;

  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  const derived = resolved.scope.params.spec_derived as Record<string, unknown>;
  assert.ok(derived, "resolution computes params.spec_derived for contracts");
  assert.equal(derived.tear_off, true, "tear-off derives from the tearoff row");
  assert.equal(derived.haul_debris, true, "debris disposal derives from the tear-off description");
  assert.equal(derived.ridge_vent, true, "ridge vent derives from its row");
  assert.equal(derived.install_shingle_system, true, "shingle system derives from the shingle row");
  assert.equal(derived.gutters_5in, true, "gutters derive from the gutter row");
  assert.equal(derived.underlayment, "tiger_paw", "underlayment type derives from the Tiger Paw row");
  assert.ok(!derived.flashing_pipes, "absent scope rows derive unchecked");
  assert.ok(!derived.gutter_covers, "gutter covers not derived from plain gutter rows");

  // Glyphs: derived checks render checked, absent ones stay empty.
  const blocks = collectBlockTexts(resolved.resolved_definition);
  assert.ok(blocks.some((text) => text.includes("☑ Continuous ridge vent")), "derived ridge vent renders checked");
  assert.ok(blocks.some((text) => text.includes("☑ Install complete shingle roof system")), "derived shingle system renders checked");
  assert.ok(blocks.some((text) => text.includes("☑ Tiger Paw") && text.includes("☐ Synthetic")), "derived underlayment checks only the matching type");
  assert.ok(blocks.some((text) => text.includes("☐ Pipe flashings")), "underived flashing stays unchecked");

  // Included rows hide their separate prices but still contribute to the package total.
  const expectedCents = 20 * 8500 + 40 * 1200 + 20 * 3000 + 20 * 39800 + 100 * 900;
  const computed = resolved.resolved_definition.computed_values;
  assert.equal(computed.scope_subtotal_cents, expectedCents, "scope subtotal sums the enriched rows");
  assert.equal(computed.contract_price_cents, expectedCents, "contract price falls back to the scope total");
  assert.equal(computed.contract_total_cents, expectedCents, "total follows the derived price at 0% tax");
  assert.equal(computed.balance_due_cents, expectedCents, "balance due follows the derived total");

  // Explicit override: rep-entered price beats the scope total; spec override
  // unchecks a derived box.
  await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${documentId}`, {
    params: { pricing: { contract_price_cents: 999900, tax_rate_percent: 0 }, spec: { ridge_vent: false } }
  });
  const overridden = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  assert.equal(overridden.resolved_definition.computed_values.contract_price_cents, 999900, "explicit contract price overrides the scope total");
  const overriddenBlocks = collectBlockTexts(overridden.resolved_definition);
  assert.ok(overriddenBlocks.some((text) => text.includes("☐ Continuous ridge vent")), "explicit spec false overrides the derived check");
});

test("three-option proposal: slot normalization builds options, detail pages repeat, summary compares, choice solidifies", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_three_option";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    template_id: "tpl_three_option_proposal",
    title: "Good Better Best",
    params: {
      customer: { name: "Jane Homeowner", email: "jane@example.test" },
      option_a_items: [{ id: "a_roof", name: "Architectural shingle system", quantity: 1, unit: "job", unit_price: 38000 }],
      option_b_items: [
        { id: "b_roof", name: "Designer shingle system", quantity: 1, unit: "job", unit_price: 45000 },
        { id: "b_vent", name: "Ridge vent upgrade", quantity: 1, unit: "ea", unit_price: 2000 }
      ],
      option_c_items: [
        { id: "c_roof", name: "Premium shingle system", quantity: 1, unit: "job", unit_price: 54000 },
        { id: "c_vent", name: "Full ventilation package", quantity: 1, unit: "ea", unit_price: 2500 },
        { id: "c_gutter", name: "Seamless gutters + covers", quantity: 1, unit: "ea", unit_price: 1500 }
      ],
      option_b_summary: "Our most popular package",
      tax_percent: 0
    }
  });
  const documentId = created.document.id as string;
  assert.equal(created.document.workflow_ref.workflow_id, "wfl_three_option_proposal", "three-option workflow attached via template metadata");

  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  const options = resolved.scope.params.proposal_options as any[];
  assert.equal(options.length, 3, "option_a/b/c slots synthesize proposal_options");
  assert.deepEqual(options.map((option) => option.id), ["option_a", "option_b", "option_c"]);
  assert.deepEqual(options.map((option) => option.label), ["Good", "Better", "Best"], "labels default Good/Better/Best");
  assert.deepEqual(options.map((option) => option.total_cents), [3800000, 4700000, 5800000], "per-option totals enrich in cents");
  assert.equal(options[1].price_cents, 4700000, "choice-card price alias set");
  assert.equal(options[1].description, "Our most popular package", "summary aliases into the choice-card description");

  // cover + one detail page per option + summary + signature.
  const pages = resolved.resolved_definition.pages as any[];
  assert.equal(pages.length, 6, "page repeat stamps one detail page per option");
  const resolvedJson = JSON.stringify(resolved.resolved_definition);
  assert.ok(resolvedJson.includes("$38,000.00") && resolvedJson.includes("$47,000.00") && resolvedJson.includes("$58,000.00"),
    "summary/detail pages render all three totals");
  const summaryPage = pages.find((page: any) => page.name === "Compare options");
  assert.ok(summaryPage, "summary page present");
  const cards = findNodeByType({ pages: [summaryPage] }, "repeater");
  assert.equal(cards.children.length, 3, "summary compare renders three option cards");
  assert.equal(cards.props.layout.columns, 3, "summary cards lay out in three columns");
  let choiceWidget: any = null;
  walkDefinitionNodes({ pages: [summaryPage] }, (node) => {
    if (!choiceWidget && node.type === "widget" && String(node.props?.widget || "").startsWith("doc.choice_group")) choiceWidget = node;
  });
  assert.ok(choiceWidget, "summary page carries the choice group widget");
  assert.equal(choiceWidget.props.config.output_key, "option_choice", "choice group writes outputs.option_choice");
  assert.equal((choiceWidget.props.config.options as any[]).length, 3, "widget config options interpolate from proposal_options");
  assert.equal((choiceWidget.props.config.options as any[])[2].label, "Best");

  // Choice solidifies scope_items from the chosen slot-built option.
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/outputs/option_choice`, { value: "option_b" });
  const after = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}`);
  const solidified = after.document.params.scope_items as any[];
  assert.equal(solidified.length, 2, "scope_items derive from the chosen option");
  assert.equal(solidified[0].name, "Designer shingle system");
  const afterResolve = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  assert.equal(afterResolve.resolved_definition.computed_values.subtotal_cents, 4700000, "computed totals follow the solidified option");
});

test("draft re-template: template_ref/workflow_ref patch merges defs, keeps params, resets workflow state; non-draft rejected", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_retemplate";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    title: "Convertible Proposal",
    params: {
      customer: { name: "Jane Homeowner", email: "jane@example.test" },
      scope_items: SCOPE_ITEMS,
      tax_percent: 7
    }
  });
  const documentId = created.document.id as string;
  assert.equal(created.document.template_ref.template_id, "tpl_proposal_default", "starts on the standard proposal template");
  assert.equal(created.document.workflow_ref.workflow_id, "wfl_roofing_proposal_intake");

  // Complete a step on the OLD workflow so pruning is observable after switch.
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/workflow/state`, {
    complete_step: "st_what"
  });

  // Convert flow (rail card "Add variant" on a standard proposal): copy the
  // scope into option slots and repoint template + workflow in one PATCH.
  const patched = await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${documentId}`, {
    params: {
      option_a_items: SCOPE_ITEMS,
      option_a_label: "Option A",
      option_b_items: SCOPE_ITEMS,
      option_b_label: "Option B"
    },
    template_ref: { template_id: "tpl_three_option_proposal" },
    workflow_ref: { workflow_id: "wfl_three_option_proposal" }
  });
  assert.equal(patched.document.template_ref.template_id, "tpl_three_option_proposal", "template ref switched");
  assert.ok(Number(patched.document.template_ref.version) >= 1, "template version pinned to the published version");
  assert.equal(patched.document.workflow_ref.workflow_id, "wfl_three_option_proposal", "workflow ref switched");
  assert.ok(Number(patched.document.workflow_ref.version) >= 1, "workflow version pinned");
  assert.equal(patched.document.workflow_state.current_step, "st_option_a", "workflow state resets to the new first step");
  assert.deepEqual(patched.document.workflow_state.completed_steps, [], "completed steps pruned to surviving step ids");
  // Existing param VALUES survive; new slot params land.
  assert.equal((patched.document.params.scope_items as any[]).length, 2, "scope_items preserved through the switch");
  assert.equal(patched.document.params.tax_percent, 7, "unrelated params untouched");
  assert.equal((patched.document.params.option_b_items as any[]).length, 2, "slot params from the same PATCH land");
  // Defs merged from the new template (template wins over stale defs).
  assert.ok(patched.document.param_defs.option_b_items, "new template param defs merged into param_defs");
  assert.ok(patched.document.param_defs.option_c_label, "all slot defs present");
  assert.ok(patched.document.output_defs.option_choice, "new template output defs merged into output_defs");

  // The workflow route follows the new ref; option B/C steps carry `when`
  // slot gates (runtime-evaluated — the full step list still serves).
  const detail = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/workflow`);
  assert.deepEqual(
    detail.workflow.steps.map((step: any) => step.id),
    ["st_option_a", "st_option_b", "st_option_c", "st_choice", "st_review"],
    "workflow detail serves the three-option definition"
  );
  const stepB = detail.workflow.steps.find((step: any) => step.id === "st_option_b");
  const stepC = detail.workflow.steps.find((step: any) => step.id === "st_option_c");
  const stepA = detail.workflow.steps.find((step: any) => step.id === "st_option_a");
  assert.equal(stepB.when, "{{not_empty(params.option_b_items)}}", "option B gated on its slot");
  assert.equal(stepC.when, "{{not_empty(params.option_c_items)}}", "option C gated on its slot");
  assert.ok(!stepA.when, "option A is always visible");

  // Resolution synthesizes proposal_options from the two filled slots.
  const resolved = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {});
  const options = resolved.scope.params.proposal_options as any[];
  assert.equal(options.length, 2, "filled slots synthesize options after the switch");
  assert.deepEqual(options.map((option) => option.label), ["Option A", "Option B"]);

  // Unknown target template is rejected.
  const badTpl = await client.raw("PATCH", `/v1/documents/organizations/${orgId}/documents/${documentId}`, {
    template_ref: { template_id: "tpl_does_not_exist" }
  });
  assert.ok(badTpl.statusCode >= 400, "unknown template rejected");

  // Non-draft documents cannot switch.
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/issue`, {});
  const locked = await client.raw("PATCH", `/v1/documents/organizations/${orgId}/documents/${documentId}`, {
    template_ref: { template_id: "tpl_proposal_default" }
  });
  assert.equal(locked.statusCode, 409, "re-template on a non-draft conflicts");
  assert.equal(JSON.parse(locked.body).error, "document_not_draft");
});

test("seeded pricing adjustments: default rows respond to checkout in resolve and the public pricing preview", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_default_adjustments";
  await createProject(client, orgId, projectId);

  const BASE = 1350000; // SCOPE_ITEMS base subtotal
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    title: "Adjustments Demo",
    params: {
      customer: { name: "Jane Homeowner", email: "jane@example.test" },
      scope_items: SCOPE_ITEMS,
      tax_percent: 0
      // no pricing_adjustments -> template default (ACH / card / early rows)
    }
  });
  const documentId = created.document.id as string;
  const seededRows = created.document.params.pricing_adjustments as any[];
  assert.equal(seededRows.length, 3, "default pricing_adjustments seeded onto the instance params");
  assert.deepEqual(seededRows.map((row) => row.id), ["disc_ach", "fee_card", "disc_early"]);

  // Card checkout: 3% processing fee, computed via rows_subtotal_cents.
  const card = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {
    checkout: { payment_method: "card" }
  });
  const cardFee = Math.round(BASE * 0.03);
  const cardRows = card.scope.params.pricing_rows as any[];
  assert.equal(cardRows.length, 1, "only the card fee row survives the flat projection under card");
  assert.equal(cardRows[0].id, "fee_card");
  assert.equal(cardRows[0].amount_cents, cardFee, "card fee formula evaluates against the scope base subtotal");
  assert.equal(cardRows[0].badge, "3% card fee", "badge carries through for the row chip");
  assert.equal(card.resolved_definition.computed_values.adjustments_cents, cardFee, "computed adjustments pick up the fee");
  assert.equal(card.resolved_definition.computed_values.total_cents, BASE + cardFee, "computed total includes the adjustment");
  assert.equal((card.scope.params.scope_rows as any[]).length, 2, "scope rows stay unpolluted by adjustments");
  assert.ok(JSON.stringify(card.resolved_definition).includes("Card processing fee"), "adjustments repeater renders the fee row");

  // ACH checkout: 2% discount (negative cents).
  const ach = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/resolve`, {
    checkout: { payment_method: "ach" }
  });
  const achDiscount = -Math.round(BASE * 0.02);
  assert.equal(ach.resolved_definition.computed_values.adjustments_cents, achDiscount, "ACH discount reduces the computed totals");
  assert.equal((ach.scope.params.pricing_rows as any[])[0].id, "disc_ach");
  assert.equal((ach.scope.params.pricing_rows as any[])[0].amount_cents, achDiscount);

  // Public pricing preview (portal pay flow): early-signing discount joins
  // after send; totals respond per payment method.
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/send`, {});
  const token = sent.snapshot.public_token as string;
  const earlyDiscount = -Math.round(BASE * 0.03);
  const previewCard = await client.request("POST", `/v1/documents/public/${token}/pricing`, { checkout: { payment_method: "card" } });
  assert.equal(previewCard.totals.total_cents, BASE + cardFee + earlyDiscount, "card preview = base + fee + early discount");
  assert.equal(previewCard.totals.adjustments_cents, cardFee + earlyDiscount, "preview reports the adjustment subtotal");
  const previewAch = await client.request("POST", `/v1/documents/public/${token}/pricing`, { checkout: { payment_method: "ach" } });
  assert.equal(previewAch.totals.total_cents, BASE + achDiscount + earlyDiscount, "ach preview = base + discount + early discount");
  assert.notEqual(previewCard.totals.total_cents, previewAch.totals.total_cents, "payment method changes the authoritative total");
  const adjustmentInventory = (previewCard.conditional_rows as any[]).filter((row) => ["disc_ach", "fee_card", "disc_early"].includes(row.id));
  assert.equal(adjustmentInventory.length, 3, "preview inventories every adjustment row with its expression");
  assert.ok(adjustmentInventory.every((row) => typeof row.condition === "string" && row.condition.length > 0));
});

test("lifecycle safety: signer party enforced on the public link, empty signatures never satisfy, void revokes tokens and blocks outputs", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_void_guard";
  await createProject(client, orgId, projectId);

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "contract",
    title: "Void Guard Contract",
    params: { body: "Agreement body", effective_date: "2026-08-01" }
  });
  const documentId = created.document.id as string;
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/issue`, {});
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/send`, {
    recipients: [{ name: "Jane Homeowner", email: "jane@example.test", role: "customer" }]
  });
  const token = sent.snapshot.public_token as string;
  assert.ok(token, "send minted a public token");

  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "platform.expanded_access": false });
  const disabledOutput = await client.raw("POST", `/v1/documents/public/${token}/outputs/sig_customer`, { value: {} });
  assert.equal(disabledOutput.statusCode, 403, "rollout revocation blocks new public document responses");
  assert.equal((await client.raw("GET", `/v1/documents/public/${token}`)).statusCode, 200, "previously issued documents remain readable");
  await saveCapabilityValues(orgId, { "platform.expanded_access": true });

  // Company-party signatures can never be recorded through the customer link.
  const companyViaPublic = await client.raw("POST", `/v1/documents/public/${token}/outputs/sig_company`, {
    value: { type: "typed", text: "Sneaky Customer", signer_name: "Sneaky Customer" }
  });
  assert.equal(companyViaPublic.statusCode, 403, "public surface rejects internal-signer outputs");

  // ...but the internal surface may record them.
  const companyViaInternal = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/outputs/sig_company`, {
    value: { type: "typed", text: "Owner User", signer_name: "Owner User" }
  });
  assert.notEqual(companyViaInternal.status, "signed", "optional company signature alone does not sign the contract");

  // An empty signature payload records but never satisfies the requirement.
  const emptySig = await client.request("POST", `/v1/documents/public/${token}/outputs/sig_customer`, { value: {} });
  assert.notEqual(emptySig.document.status, "signed", "bare {} does not count as a customer signature");

  const realSig = await client.request("POST", `/v1/documents/public/${token}/outputs/sig_customer`, {
    value: { type: "typed", text: "Jane Homeowner", signer_name: "Jane Homeowner" }
  });
  assert.equal(realSig.document.status, "completed", "a real signature signs the contract (no payment gate, so it completes)");

  // --- void: second document, cancel it, links + outputs go dead ------------
  const second = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "contract",
    title: "Superseded Contract",
    params: { body: "Old terms", effective_date: "2026-08-01" }
  });
  const secondId = second.document.id as string;
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${secondId}/issue`, {});
  const secondSent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${secondId}/send`, {
    recipients: [{ name: "Jane Homeowner", email: "jane@example.test", role: "customer" }]
  });
  const secondToken = secondSent.snapshot.public_token as string;

  const voided = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${secondId}/void`, {
    reason: "Customer requested a new estimate",
    customer_visibility: "hidden"
  });
  assert.equal(voided.document.status, "void");
  assert.equal(voided.document.cancellation.customer_visibility, "hidden");
  assert.equal(voided.document.cancellation.reason, "Customer requested a new estimate");
  assert.ok(voided.document.cancellation.canceled_at, "cancellation timestamp recorded");

  // The old link no longer resolves and outputs are rejected everywhere.
  const deadLink = await client.raw("GET", `/v1/documents/public/${secondToken}`);
  assert.equal(deadLink.statusCode, 404, "public token is revoked after void");
  const deadOutput = await client.raw("POST", `/v1/documents/public/${secondToken}/outputs/sig_customer`, {
    value: { type: "typed", text: "Jane Homeowner", signer_name: "Jane Homeowner" }
  });
  assert.equal(deadOutput.statusCode, 404, "outputs through the revoked token are rejected");
  const internalOutput = await client.raw("POST", `/v1/documents/organizations/${orgId}/documents/${secondId}/outputs/sig_customer`, {
    value: { type: "typed", text: "Jane Homeowner", signer_name: "Jane Homeowner" }
  });
  assert.equal(internalOutput.statusCode, 409, "void documents no longer accept outputs on any surface");

  // Voiding emits a real work-engine event and stays terminal.
  const events = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${secondId}/events`);
  assert.ok(events.events.some((event: any) => event.type === "document.voided"), "document.voided event recorded");
});
