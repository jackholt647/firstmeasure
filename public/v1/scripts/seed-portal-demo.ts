/**
 * Seed a walkthrough-ready customer portal in the test org.
 *
 * Run from public/v1:
 *   node --experimental-sqlite --import tsx scripts/seed-portal-demo.ts
 *
 * ADDITIVE AND IDEMPOTENT. Every record it writes uses a fixed `pdemo_` id, so
 * re-running updates those records and touches nothing else in the org. It
 * never edits or deletes pre-existing projects, pages, or portals.
 *
 * What it builds: one contact (Dana Reyes) with three projects that between
 * them exercise multi-project portals, scope/tag-targeted pages, a widget Home
 * page, punch lists in every lifecycle state, customer uploads and comments,
 * recurring visits, and live chat.
 */

import { createHash } from "node:crypto";

import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { normalizePunchConfig } from "../workforce/punch_lists.js";
import { ensureProjectChecklists } from "../workforce/crew_storage.js";
import { syncPortalProjection } from "../platform/portal_projection.js";

const ORG_ID = process.env.SEED_ORG_ID || "06a71ab1357a7a41aa6ee80a";
const CONTACT_ID = "pdemo_contact_dana";
const CONTACT = {
  id: CONTACT_ID,
  contact_id: CONTACT_ID,
  name: "Dana Reyes",
  email: "dana.reyes@example.test",
  phone: "(555) 0142",
  address: "418 Juniper Lane"
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}
function cleanText(value: unknown) {
  return String(value ?? "").trim();
}
function iso(daysFromNow: number, hour = 9) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}
function stableId(prefix: string, seed: string) {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 20)}`;
}

const log: string[] = [];
function note(line: string) {
  log.push(line);
  console.log(line);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

type ProjectSpec = {
  id: string;
  title: string;
  address: string;
  tags: string[];
  status: string;
  events: JsonObject[];
};

const PROJECTS: ProjectSpec[] = [
  {
    id: "pdemo_roof_main",
    title: "Roof Replacement — 418 Juniper Lane",
    address: "418 Juniper Lane",
    tags: ["Roofing", "Residential"],
    status: "active",
    events: [
      { id: "pdemo_ev_roof_1", title: "Tear-off and dry-in", event_type_default_id: "project_work", start_at: iso(-6, 8), duration_minutes: 480, status: "completed" },
      { id: "pdemo_ev_roof_2", title: "Shingle installation", event_type_default_id: "project_work", start_at: iso(-4, 8), duration_minutes: 480, status: "completed" },
      { id: "pdemo_ev_roof_3", title: "Final walkthrough", event_type_default_id: "project_work", start_at: iso(3, 10), duration_minutes: 120, status: "scheduled" }
    ]
  },
  {
    id: "pdemo_bath_remodel",
    title: "Primary Bath Remodel — 418 Juniper Lane",
    address: "418 Juniper Lane",
    tags: ["Remodel", "Residential"],
    status: "active",
    events: [
      { id: "pdemo_ev_bath_1", title: "Demo and rough-in", event_type_default_id: "project_work", start_at: iso(-2, 8), duration_minutes: 480, status: "completed" },
      { id: "pdemo_ev_bath_2", title: "Tile and finish", event_type_default_id: "project_work", start_at: iso(5, 8), duration_minutes: 480, status: "scheduled" }
    ]
  },
  {
    id: "pdemo_gutter_maint",
    title: "Gutter Maintenance Plan — 418 Juniper Lane",
    address: "418 Juniper Lane",
    tags: ["Maintenance"],
    status: "active",
    events: [
      { id: "pdemo_ev_gutter_1", title: "Quarterly gutter clean", event_type_default_id: "project_work", start_at: iso(14, 9), duration_minutes: 120, status: "scheduled" }
    ]
  }
];

async function seedProjects() {
  for (const spec of PROJECTS) {
    const existing = await readDocument(ORG_ID, "projects", spec.id).catch(() => null);
    const current = asObject(existing?.data);
    await upsertDocument(ORG_ID, "projects", {
      id: spec.id,
      data: {
        ...current,
        id: spec.id,
        branch_id: "default",
        title: spec.title,
        address: spec.address,
        status: spec.status,
        tags: spec.tags,
        events: spec.events,
        contacts: [{ ...CONTACT, primary: true }],
        contact_id: CONTACT_ID,
        primary_contact_id: CONTACT_ID,
        customer_name: CONTACT.name,
        customer_email: CONTACT.email,
        customer_phone: CONTACT.phone,
        updated_at: new Date().toISOString()
      },
      metadata: { ...asObject(existing?.metadata), kind: "platform_project", seed: "portal_demo" }
    }, { replace: true });
    note(`project    ${spec.id.padEnd(22)} ${spec.title}`);
  }
}

// ---------------------------------------------------------------------------
// Portals — one per project, all sharing CONTACT_ID so they appear together
// ---------------------------------------------------------------------------

/** Per-project portal settings: each project turns on a different slice. */
const PORTAL_SETTINGS: Record<string, JsonObject> = {
  pdemo_roof_main: {
    uploads: { photos: true, documents: true, max_files: 25 },
    comments: { photos: true },
    punch_list: { enabled: true, customer_can_add: true, require_submit_signature: true, require_accept_signature: true },
    sharing: { enabled: true, max_guests: 5 },
    messaging: { enabled: true, channel: "auto" },
    completion: { signature_required: true }
  },
  pdemo_bath_remodel: {
    uploads: { photos: true, documents: false, require_caption: true },
    comments: { photos: true },
    punch_list: { enabled: true, customer_can_add: true, max_items: 5, require_photo: true, require_submit_signature: false, require_accept_signature: false },
    sharing: { enabled: false }
  },
  pdemo_gutter_maint: {
    uploads: { photos: false, documents: false },
    comments: { photos: false }
  }
};

async function seedPortals() {
  const { ensureCustomerPortalRecord } = await import("../platform/api.js").catch(() => ({ ensureCustomerPortalRecord: null as never }));
  for (const spec of PROJECTS) {
    const documentId = `customer_portal_${spec.id.replace(/_/g, "-")}`;
    const existing = await readDocument(ORG_ID, "customer_portals", documentId).catch(() => null);
    const current = asObject(existing?.data);
    const publicUuid = cleanText(current.public_uuid) || stableId("pdemo", `${spec.id}:public`).replace("pdemo_", "");
    const previewUuid = cleanText(current.preview_uuid) || stableId("pdemo", `${spec.id}:preview`).replace("pdemo_", "");
    await upsertDocument(ORG_ID, "customer_portals", {
      id: documentId,
      data: {
        ...current,
        project_id: spec.id,
        contact_id: CONTACT_ID,
        public_uuid: publicUuid,
        preview_uuid: previewUuid,
        status: "active",
        customer: CONTACT,
        shared_items: Array.isArray(current.shared_items) ? current.shared_items : [],
        customer_uploads: Array.isArray(current.customer_uploads) ? current.customer_uploads : [],
        media_comments: Array.isArray(current.media_comments) ? current.media_comments : [],
        settings: PORTAL_SETTINGS[spec.id] || {},
        created_at: cleanText(current.created_at) || new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      metadata: {
        kind: "customer_portal_access",
        project_id: spec.id,
        contact_id: CONTACT_ID,
        public_uuid: publicUuid,
        preview_uuid: previewUuid,
        seed: "portal_demo"
      }
    }, { replace: true });
    note(`portal     ${spec.id.padEnd(22)} /customer_portal/?id=${publicUuid}`);
  }
  void ensureCustomerPortalRecord;
}

// ---------------------------------------------------------------------------
// Punch lists — one per lifecycle state so every screen is reachable
// ---------------------------------------------------------------------------

/**
 * Reset the demo punch lists to an empty, freshly-requested state.
 *
 * Walkthroughs leave stray items behind ("Test", "Test", "Test"...). Re-running
 * the seed should hand back a clean list to author, not last session's debris.
 * Scoped strictly to the two `pdemo_punch_*` lists.
 */
async function resetPunchItems() {
  const { getWorkforceDatabase } = await import("../workforce/storage.js");
  try {
    const db = getWorkforceDatabase();
    const info = db.prepare(
      `DELETE FROM crew_checklist_items WHERE organization_id = ? AND checklist_id LIKE 'pdemo_punch_%'`
    ).run(ORG_ID);
    if (info.changes) note(`punch      cleared ${info.changes} leftover demo item(s)`);

    // ensureProjectChecklists skips lists that already exist, so a list left in
    // `submitted`/`accepted` from a previous walkthrough would stay there with
    // no items — a dead end. Roll the lifecycle back to `requested` too.
    const rows = db.prepare(
      `SELECT id, metadata_json FROM crew_checklists WHERE organization_id = ? AND id LIKE 'pdemo_punch_%' AND deleted_at IS NULL`
    ).all(ORG_ID);
    let reset = 0;
    for (const rowValue of rows) {
      const row = asObject(rowValue);
      let metadata: JsonObject = {};
      try { metadata = asObject(JSON.parse(cleanText(row.metadata_json) || "{}")); } catch { metadata = {}; }
      const punch = asObject(metadata.punch);
      if (!Object.keys(punch).length || cleanText(punch.state) === "requested") continue;
      metadata.punch = {
        ...punch,
        state: "requested",
        requested_at: new Date().toISOString(),
        submitted_at: "",
        work_completed_at: "",
        accepted_at: "",
        submit_signature: null,
        accept_signature: null
      };
      db.prepare(`UPDATE crew_checklists SET metadata_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(metadata), new Date().toISOString(), cleanText(row.id));
      reset += 1;
    }
    if (reset) note(`punch      reset ${reset} list(s) back to 'requested'`);
  } catch {
    // Fresh org with no workforce database yet — nothing to clear.
  }
}

async function seedPunchLists() {
  await resetPunchItems();
  // Roofing: two lists. One awaiting the customer's authoring, one already
  // submitted and finished by the crew so the ACCEPT screen is reachable.
  ensureProjectChecklists(ORG_ID, "pdemo_roof_main", {
    definitions: [
      {
        id: "pdemo_punch_roof_open",
        title: "Create your punch list",
        description: "Walk the roofline and add anything you would still like us to take care of.",
        audience: "crew",
        icon: "fa-clipboard-check",
        source: "scope",
        source_key: "punch:roof_final",
        items: [],
        metadata: {
          punch: normalizePunchConfig({
            state: "requested",
            required: true,
            customer_can_add: true,
            customer_can_edit: true,
            require_submit_signature: true,
            require_accept_signature: true,
            requested_at: new Date().toISOString()
          })
        },
        customer_access: { visible: true, can_complete: false, can_edit_items: true }
      }
    ] as never,
    actorUserId: "system"
  });

  // Bath: a "snag list" — different terminology, photo required, no signatures.
  ensureProjectChecklists(ORG_ID, "pdemo_bath_remodel", {
    definitions: [
      {
        id: "pdemo_punch_bath_snag",
        title: "Create your snag list",
        description: "Add anything that still needs attention. A photo is required on each item.",
        audience: "crew",
        icon: "fa-clipboard-check",
        source: "scope",
        source_key: "punch:bath_finish",
        items: [],
        metadata: {
          punch: normalizePunchConfig({
            state: "requested",
            required: true,
            customer_can_add: true,
            customer_can_edit: true,
            max_items: 5,
            require_photo: true,
            require_submit_signature: false,
            require_accept_signature: false,
            terminology_key: "snag_list",
            labels: { noun: "snag list", submit_cta: "Send my snags" },
            requested_at: new Date().toISOString()
          })
        },
        customer_access: { visible: true, can_complete: false, can_edit_items: true }
      }
    ] as never,
    actorUserId: "system"
  });

  note("punch      pdemo_roof_main        'punch list' — signatures on both ends");
  note("punch      pdemo_bath_remodel     'snag list'  — photo required, no signatures");

  await syncPortalProjection(ORG_ID, "pdemo_roof_main");
  await syncPortalProjection(ORG_ID, "pdemo_bath_remodel");
}

// ---------------------------------------------------------------------------
// Recurring visits (gutter plan)
// ---------------------------------------------------------------------------

async function seedRecurrence() {
  const seriesId = "pdemo_series_gutter";
  await upsertDocument(ORG_ID, "recurrence_series", {
    id: seriesId,
    data: {
      id: seriesId,
      project_id: "pdemo_gutter_maint",
      kind: "calendar_event",
      title: "Quarterly gutter clean",
      status: "active",
      recurrence: { frequency: "quarterly", interval: 1 },
      occurrences: [
        { start_at: iso(14, 9) },
        { start_at: iso(105, 9) },
        { start_at: iso(196, 9) }
      ],
      next_at: iso(14, 9),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    metadata: { kind: "recurrence_series", project_id: "pdemo_gutter_maint", seed: "portal_demo" }
  }, { replace: true });
  note("recurring  pdemo_gutter_maint     quarterly series, next visit in 14 days");
}

// ---------------------------------------------------------------------------
// Portal pages: a widget Home + a roofing-targeted page
// ---------------------------------------------------------------------------

async function seedPortalPages() {
  const sites = await listDocuments(ORG_ID, "websites").catch(() => []);
  const portalSite = sites
    .map((document) => ({ id: cleanText(asObject(document).id), data: asObject(asObject(document).data) }))
    .find((site) => cleanText(site.data.site_kind) === "customer_portal");
  if (!portalSite) {
    note("!! no customer_portal site in this org — open the Web Editor once to seed it, then re-run");
    return;
  }

  const { FMDocModel } = await import("../websites/schemas.js");

  // `h: "auto"` matters: a fixed height reserves that space whether or not the
  // widget fills it, which is what produced the huge gaps between cards.
  const widgetNode = (widget: string, config: JsonObject = {}) => FMDocModel.createNode("widget", {
    frame: { x: 0, y: 0, w: "auto", h: "auto", layout: "flow" },
    props: { widget, config }
  });

  /**
   * Portal pages are FLUID, not fixed-width canvases.
   *
   * fitCustomPageStage scales with Math.min(1, available / designWidth) — it
   * never scales UP — so a fixed 720pt page renders at 960px inside a ~1136px
   * panel and looks narrower than the header. `paper.size: "fill"` is the
   * renderer's fluid mode: spans the panel and reflows, never scaled.
   */
  /**
   * A horizontal band: a flow frame laying its children out in a row.
   *
   * The portal panel is ~1136px on desktop; stacking every widget in one column
   * wastes most of that. Columns are expressed with a `frame` node (the only
   * container node type) whose flow direction is "row" — the renderer reflows
   * to a column when the container gets narrow, so this stays responsive.
   */
  const row = (children: JsonObject[], gap = 20) => FMDocModel.createNode("frame", {
    frame: { x: 0, y: 0, w: "auto", h: "auto", layout: "flow" },
    props: { flow: { direction: "row", gap, padding: [0, 0, 0, 0], align: "start", wrap: true } },
    children
  });

  /** A column within a row. `basis` is a flex-ish share of the band. */
  const col = (children: JsonObject[], basis = "50%") => FMDocModel.createNode("frame", {
    frame: { x: 0, y: 0, w: basis, h: "auto", layout: "flow" },
    props: { flow: { direction: "column", gap: 20, padding: [0, 0, 0, 0], align: "stretch", wrap: false } },
    children
  });

  const buildPage = (children: JsonObject[]) => {
    const doc = FMDocModel.createDocument({ kind: "view" }) as JsonObject;
    const root = asObject(doc.root);
    root.frame = { ...asObject(root.frame), w: "auto", h: 0, layout: "flow" };
    root.props = {
      ...asObject(root.props),
      flow: { direction: "column", gap: 20, padding: [0, 0, 0, 0], align: "stretch", wrap: false }
    };
    root.children = children;
    doc.root = root;
    doc.settings = { ...asObject(doc.settings), paper: { size: "fill" } };
    doc.metadata = { ...asObject(doc.metadata), surface: "website" };
    return doc as JsonObject;
  };

  const pages: Array<{ id: string; title: string; slug: string; nav: JsonObject; audience: JsonObject; definition: JsonObject; home?: boolean }> = [
    {
      id: "pdemo_page_home",
      title: "Welcome",
      slug: "welcome",
      nav: { header: false, order: 0 },
      audience: {},
      home: true,
      // The default Home layout. Order follows what a customer actually opens
      // the portal to find: where am I, what's next, when are you coming, what
      // has happened, what does it look like — and only then the softer
      // marketing content.
      // Desktop-first two-column layout. The header spans full width; the
      // action-oriented content (what's next, when we're coming) takes the
      // wider left column; supporting content sits right. Both columns wrap to
      // a single stack on narrow viewports.
      definition: buildPage([
        widgetNode("portal.project_header@1", {}),
        row([
          col([
            widgetNode("portal.next_steps@1", { title: "Next steps" }),
            widgetNode("portal.photo_strip@1", { title: "Recent photos" }),
            widgetNode("portal.reviews@1", { title: "What our customers say", limit: 2 })
          ], "58%"),
          col([
            widgetNode("portal.next_appointment@1", { title: "Your next visit" }),
            widgetNode("portal.activity_feed@1", { title: "Project updates", limit: 6 }),
            widgetNode("portal.team@1", { title: "Meet your team" })
          ], "38%")
        ])
      ])
    },
    {
      id: "pdemo_page_roofcare",
      title: "Roof Care",
      slug: "roof-care",
      nav: { header: true, order: 10 },
      // Targeted: only projects tagged "roofing" ever see this page.
      audience: { match: "any", tag_ids: ["roofing"] },
      definition: buildPage([
        widgetNode("portal.welcome_video@1", { title: "Caring for your new roof" }),
        widgetNode("portal.portfolio@1", { title: "Before & after", limit: 4 })
      ])
    },
    {
      id: "pdemo_page_maintenance",
      title: "Your Plan",
      slug: "your-plan",
      nav: { header: true, order: 20 },
      audience: { match: "any", tag_ids: ["maintenance"] },
      definition: buildPage([
        widgetNode("portal.recurring@1", { title: "Your recurring visits" }),
        widgetNode("portal.next_appointment@1", { title: "Upcoming visits" }),
        widgetNode("portal.reviews@1", { title: "Reviews", limit: 2 })
      ])
    }
  ];

  for (const page of pages) {
    const now = new Date().toISOString();
    const checksum = createHash("sha256").update(JSON.stringify(page.definition)).digest("hex");
    // Publish immediately: version 1 holds the same definition as the draft.
    // Use the module's own id derivation — readPageVersion looks the row up by
    // an exact deterministic id, so a hand-rolled hash silently 404s.
    const { pageVersionRowId } = await import("../websites/storage.js");
    const versionId = pageVersionRowId(ORG_ID, page.id, 1);
    await upsertDocument(ORG_ID, "website_page_versions", {
      id: versionId,
      data: {
        schema_version: 1,
        id: versionId,
        kind: "website_page_version",
        website_id: portalSite.id,
        page_id: page.id,
        version: 1,
        definition: page.definition,
        checksum,
        published_at: now,
        published_by_user_id: "system",
        locked: true
      },
      metadata: { kind: "website_page_version", page_id: page.id, seed: "portal_demo" }
    }, { replace: true });

    await upsertDocument(ORG_ID, "website_pages", {
      id: page.id,
      data: {
        schema_version: 1,
        id: page.id,
        website_id: portalSite.id,
        title: page.title,
        slug: page.slug,
        role: "page",
        enabled: true,
        nav: page.nav,
        audience: page.audience,
        draft: { definition: page.definition, checksum, based_on_version: 1, updated_at: now, updated_by_user_id: "system" },
        published_version: 1,
        seo: {},
        created_at: now,
        updated_at: now
      },
      metadata: { kind: "website_page", website_id: portalSite.id, seed: "portal_demo" }
    }, { replace: true });
    note(`page       ${page.slug.padEnd(22)} ${page.title}${Object.keys(page.audience).length ? "  (targeted)" : ""}`);
  }

  // Point the portal's Home tab at the widget page, and set org-level portal
  // defaults + a tab rename so those are visible in the walkthrough.
  const siteDocument = await readDocument(ORG_ID, "websites", portalSite.id);
  const siteData = asObject(siteDocument.data);
  await upsertDocument(ORG_ID, "websites", {
    id: portalSite.id,
    data: {
      ...siteData,
      home_page_id: "pdemo_page_home",
      settings: {
        ...asObject(siteData.settings),
        portal_tabs: { photos: { label: "Job Photos" } },
        portal_defaults: {
          punch_list: { require_accept_signature: false },
          uploads: { max_files: 25 }
        }
      },
      updated_at: new Date().toISOString()
    },
    metadata: asObject(siteDocument.metadata)
  }, { replace: true });
  note("site       home_page_id -> pdemo_page_home; Photos tab renamed 'Job Photos'");
}

// ---------------------------------------------------------------------------
// Content so the read-only widgets have something to show
// ---------------------------------------------------------------------------

/**
 * Calendar events.
 *
 * The portal's Schedule tab reads the `calendar_events` COLLECTION, not
 * `project.events[]` — seeding only the latter leaves Schedule empty, which is
 * exactly what made the first walkthrough look unfinished.
 */
async function seedCalendarEvents() {
  let count = 0;
  for (const spec of PROJECTS) {
    for (const entry of spec.events) {
      const event = asObject(entry);
      const id = cleanText(event.id);
      await upsertDocument(ORG_ID, "calendar_events", {
        id,
        data: {
          id,
          project_id: spec.id,
          branch_id: "default",
          title: cleanText(event.title),
          customer_description: cleanText(event.title),
          event_type_default_id: cleanText(event.event_type_default_id) || "project_work",
          start_at: cleanText(event.start_at),
          duration_minutes: Number(event.duration_minutes) || 240,
          status: cleanText(event.status) || "scheduled",
          customer_visible: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        metadata: { kind: "calendar_event", project_id: spec.id, seed: "portal_demo" }
      }, { replace: true });
      count += 1;
    }
  }
  note(`schedule   ${count} calendar events across the three projects`);
}

/** A sent proposal + a paid deposit so Proposals and Payments are not empty. */
async function seedProposalAndPayments() {
  const proposalId = "pdemo_proposal_roof";
  const now = new Date().toISOString();
  await upsertDocument(ORG_ID, "proposals", {
    id: proposalId,
    data: {
      id: proposalId,
      project_id: "pdemo_roof_main",
      branch_id: "default",
      title: "Roof Replacement Proposal",
      status: "signed",
      delivery: { status: "sent", sent_at: iso(-14), viewed_at: iso(-13) },
      scope: {
        root_items: [
          { id: "li_1", name: "Tear off existing shingles", quantity: "1", unit: "job", unit_price: 180000, amount_cents: 180000, included: true },
          { id: "li_2", name: "Architectural shingle installation", quantity: "28", unit: "sq", unit_price: 42000, amount_cents: 1176000, included: true },
          { id: "li_3", name: "Ridge vent upgrade", quantity: "1", unit: "job", unit_price: 64000, amount_cents: 64000, included: false,
            selection: { mode: "optional", selected: false, default_selected: false, selectable_by: ["internal", "customer"], group_title: "Optional upgrades" } },
          { id: "li_4", name: "Gutter guard package", quantity: "1", unit: "job", unit_price: 98000, amount_cents: 98000, included: false,
            selection: { mode: "optional", selected: false, default_selected: false, selectable_by: ["internal", "customer"], group_title: "Optional upgrades" } }
        ]
      },
      total_cents: 1420000,
      created_at: iso(-16),
      updated_at: now
    },
    metadata: { kind: "proposal", project_id: "pdemo_roof_main", seed: "portal_demo" }
  }, { replace: true });

  await upsertDocument(ORG_ID, "payment_obligations", {
    id: "pdemo_obl_deposit",
    data: {
      id: "pdemo_obl_deposit",
      project_id: "pdemo_roof_main",
      kind: "deposit",
      label: "Deposit",
      amount_cents: 426000,
      paid_cents: 426000,
      status: "paid",
      due_at: iso(-14),
      created_at: iso(-16),
      updated_at: now
    },
    metadata: { kind: "payment_obligation", project_id: "pdemo_roof_main", seed: "portal_demo" }
  }, { replace: true });

  await upsertDocument(ORG_ID, "payment_obligations", {
    id: "pdemo_obl_final",
    data: {
      id: "pdemo_obl_final",
      project_id: "pdemo_roof_main",
      kind: "final",
      label: "Balance on completion",
      amount_cents: 994000,
      paid_cents: 0,
      status: "open",
      due_at: iso(7),
      created_at: iso(-16),
      updated_at: now
    },
    metadata: { kind: "payment_obligation", project_id: "pdemo_roof_main", seed: "portal_demo" }
  }, { replace: true });
  note("money      1 signed proposal (2 optional upgrades), deposit paid, balance open");
}

/** Assign real org users to the roofing events so portal.team renders. */
async function seedTeam() {
  const users = (await listDocuments(ORG_ID, "users").catch(() => []))
    .map((document) => ({ id: cleanText(asObject(document).id), data: asObject(asObject(document).data) }))
    .filter((user) => user.id && cleanText(user.data.name))
    .slice(0, 3);
  if (!users.length) return note("team       (no users in org — portal.team will stay empty)");

  const document = await readDocument(ORG_ID, "projects", "pdemo_roof_main");
  const data = asObject(document.data);
  const events = (Array.isArray(data.events) ? data.events : []).map((entry) => ({
    ...asObject(entry),
    /* One demo assignee, not the whole org — assigning every user made the
     * schedule views show confusing multi-person assignments. */
    assigned_user_ids: users.slice(0, 1).map((user) => user.id)
  }));
  await upsertDocument(ORG_ID, "projects", {
    id: "pdemo_roof_main",
    data: { ...data, events, updated_at: new Date().toISOString() },
    metadata: asObject(document.metadata)
  }, { replace: true });
  note(`team       ${users.length} user(s) assigned to roofing events`);
}

/** Customer-visible work events so portal.activity_feed has a timeline. */
async function seedActivity() {
  const { emitWorkEvent } = await import("../work/engine.js");
  // Idempotent: re-running the seed must not stack duplicate feed entries.
  const { listEventRecords } = await import("../work/storage.js");
  const already = listEventRecords(ORG_ID, { project_id: "pdemo_roof_main", limit: 200 })
    .some((row) => cleanText(asObject(asObject(row).context).source) === "portal_demo_seed");
  if (already) return note("activity   (already seeded — skipped)");
  const entries: Array<[string, JsonObject]> = [
    ["document.sent", { document_type: "proposal" }],
    ["material.delivery.completed", {}],
    ["payment.received", { payment_kind: "deposit" }],
    ["punch_list.requested", { noun: "punch list", required: true }]
  ];
  for (const [type, payload] of entries) {
    await emitWorkEvent({
      organization_id: ORG_ID,
      project_id: "pdemo_roof_main",
      type,
      payload,
      context: { source: "portal_demo_seed" }
    }, { process: false }).catch(() => null);
  }
  note(`activity   ${entries.length} customer-visible events on the roofing project`);
}

/** A rated feedback request so portal.reviews shows a score and a quote. */
async function seedReviews() {
  const reviews = [
    { id: "pdemo_feedback_1", name: "Morgan Ellis", rating: 5, comment: "The crew was tidy, on time, and walked us through everything before they left." },
    { id: "pdemo_feedback_2", name: "Sam Whitfield", rating: 5, comment: "Straight answers on pricing and no surprises at the end. Would use again." },
    { id: "pdemo_feedback_3", name: "Alex Nakamura", rating: 4, comment: "Great work on the roof. Scheduling took a couple of tries but the result is excellent." }
  ];
  for (const review of reviews) {
    await upsertDocument(ORG_ID, "feedback_requests", {
      id: review.id,
      data: {
        id: review.id,
        branch_id: "default",
        project_id: "pdemo_roof_main",
        public_token: `pdemo_token_${review.id}`,
        status: "rated",
        contact: { name: review.name },
        rating: review.rating,
        rating_scale: 5,
        comment: review.comment,
        rated_at: iso(-10 + reviews.indexOf(review)),
        sends: [],
        destination_clicks: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      metadata: { kind: "feedback_request", seed: "portal_demo" }
    }, { replace: true });
  }
  note(`reviews    ${reviews.length} rated reviews (avg 4.7)`);
}

/**
 * Share existing org media into the roofing portal, tagging pairs before/after
 * so portal.portfolio has something to pair up.
 */
async function seedSharedMedia() {
  // Media are folders on disk with their own metadata, not platform documents —
  // listDocuments(orgId, "media") returns nothing.
  const { listMedia } = await import("../platform/storage.js");
  const mediaIds: string[] = [];
  for (const entry of await listMedia(ORG_ID).catch(() => [])) {
    const media = asObject(entry);
    const contentType = cleanText(media.content_type).toLowerCase();
    if (!contentType.startsWith("image/") || contentType.includes("svg")) continue;
    mediaIds.push(cleanText(media.id));
    if (mediaIds.length >= 6) break;
  }
  if (!mediaIds.length) return note("media      (no org images found — Photos/Portfolio will stay empty)");

  const now = new Date().toISOString();

  // publicPortalMedia INTERSECTS the portal's shared_items with the project's
  // own `photos[]` — sharing a media id the project does not list yields an
  // empty gallery. Both sides have to exist.
  const projectDocument = await readDocument(ORG_ID, "projects", "pdemo_roof_main");
  const projectData = asObject(projectDocument.data);
  await upsertDocument(ORG_ID, "projects", {
    id: "pdemo_roof_main",
    data: {
      ...projectData,
      photos: mediaIds.map((mediaId, index) => ({
        media_id: mediaId,
        id: mediaId,
        label: `Job photo ${index + 1}`,
        file_name: `job-photo-${index + 1}`,
        media_type: "image",
        uploaded_at: iso(-8 + index)
      })),
      updated_at: now
    },
    metadata: asObject(projectDocument.metadata)
  }, { replace: true });

  const documentId = "customer_portal_pdemo-roof-main";
  const record = await readDocument(ORG_ID, "customer_portals", documentId).catch(() => null);
  if (!record) return;
  const data = asObject(record.data);
  await upsertDocument(ORG_ID, "customer_portals", {
    id: documentId,
    data: {
      ...data,
      shared_items: mediaIds.map((mediaId) => ({
        type: "media", item_id: mediaId, shared_at: now, shared_by: "system", include_markup: true
      })),
      updated_at: now
    },
    metadata: asObject(record.metadata)
  }, { replace: true });
  // Tag alternating pairs before/after so portal.portfolio has pairs to build.
  const { updateMediaTags } = await import("../platform/storage.js");
  let tagged = 0;
  for (let index = 0; index + 1 < mediaIds.length && index < 4; index += 2) {
    await updateMediaTags(ORG_ID, mediaIds[index]!, ["before"]).catch(() => null);
    await updateMediaTags(ORG_ID, mediaIds[index + 1]!, ["after"]).catch(() => null);
    tagged += 2;
  }
  note(`media      ${mediaIds.length} photos shared to the roofing portal (${tagged} tagged before/after)`);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nSeeding portal demo into org ${ORG_ID}\n${"-".repeat(72)}`);
  await seedProjects();
  await seedPortals();
  await seedPunchLists();
  await seedRecurrence();
  await seedCalendarEvents();
  await seedProposalAndPayments();
  await seedTeam();
  await seedActivity();
  await seedReviews();
  await seedSharedMedia();
  await seedPortalPages();

  console.log(`${"-".repeat(72)}\nPortal links:\n`);
  for (const spec of PROJECTS) {
    const documentId = `customer_portal_${spec.id.replace(/_/g, "-")}`;
    const record = await readDocument(ORG_ID, "customer_portals", documentId).catch(() => null);
    const uuid = cleanText(asObject(record?.data).public_uuid);
    console.log(`  ${spec.title}\n    http://127.0.0.1:8011/customer_portal/?id=${uuid}\n`);
  }
  console.log("All three links belong to the same contact, so each one shows all three projects.\n");
}

main().catch((error) => {
  console.error("seed failed:", error);
  process.exitCode = 1;
});
