import { env } from "../../src/config/env.js";
import type { JsonObject } from "../../platform/storage.js";
import {
  moneyCents,
  normalizeScopeItem,
  scopeItemsForView
} from "../../proposals/scope.js";
import { FMDocModel } from "../schemas.js";
import {
  normalizeScheduleRows,
  resolveScheduleItems
} from "../../payments/schedule_terms.js";
import {
  registerDocumentWidgetResolver,
  type WidgetResolveContext
} from "./registry.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function roundCents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function paramsPathValue(ctx: WidgetResolveContext, sourcePath: unknown, fallbackPath: string) {
  const path = cleanText(sourcePath) || fallbackPath;
  const scope = { params: ctx.params, project: ctx.project || {}, document: ctx.document };
  return FMDocModel.getPath(scope, path);
}

export function publicDocumentPortalUrl(token: string) {
  const cleaned = cleanText(token);
  if (!cleaned) return "";
  const base = cleanText(env.publicBaseUrl);
  return `${base}/v1/documents/public/${encodeURIComponent(cleaned)}`;
}

function documentPublicToken(ctx: WidgetResolveContext) {
  const snapshotToken = cleanText(asObject(ctx.snapshot).public_token);
  if (snapshotToken) return snapshotToken;
  const delivery = asObject(ctx.document.delivery);
  return cleanText(delivery.public_token || delivery.current_public_token);
}

function mediaRefUrl(ctx: WidgetResolveContext, refValue: unknown) {
  const ref = asObject(refValue);
  const explicit = cleanText(ref.url);
  if (explicit) return explicit;
  const mediaId = cleanText(ref.media_id || ref.mediaId || ref.id);
  if (!mediaId) return "";
  return ctx.services.media.fileUrl(ctx.organizationId, mediaId, cleanText(ref.variant) || "original");
}

const MAX_DATA_URI_BYTES = 2 * 1024 * 1024;

/**
 * Static/PDF renders cannot fetch authenticated media URLs from inside the
 * Playwright harness, so small images are inlined as data URIs. Interactive
 * renders keep URLs only (the portal session/token can fetch them).
 */
async function mediaRefDataUri(ctx: WidgetResolveContext, refValue: unknown) {
  if (ctx.target !== "static") return "";
  const ref = asObject(refValue);
  const mediaId = cleanText(ref.media_id || ref.mediaId || ref.id);
  if (!mediaId) return "";
  try {
    const file = await ctx.services.media.readMediaFile(ctx.organizationId, mediaId, cleanText(ref.variant) || "original");
    if (!file.bytes.length || file.bytes.length > MAX_DATA_URI_BYTES) return "";
    if (!cleanText(file.contentType).startsWith("image/")) return "";
    return `data:${file.contentType};base64,${file.bytes.toString("base64")}`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// doc.line_items — flattens proposal-shaped scope items into printable rows.
// Reuses the proposals scope helpers so pricing math stays identical.
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("doc.line_items", async (ctx, config) => {
  const source = paramsPathValue(ctx, config.source, "params.scope_items");
  const items = asArray(source).map((item, index) => normalizeScopeItem(item, index));
  if (!items.length) return null;
  const showIncluded = config.show_included !== false;
  const depth = Math.max(0, Math.round(Number(config.depth ?? 2)) || 0);
  const flattened = scopeItemsForView({ root_items: items }, {
    root_item_id: "root",
    render_depth: depth,
    show_included_items: showIncluded,
    show_unselected_options: config.show_unselected === true
  });
  const showMedia = config.show_media === true;
  const rows = flattened.map((item) => {
    const selection = asObject(item.selection);
    return {
      id: cleanText(item.id),
      depth: Number(item.depth || 0),
      name: cleanText(item.display_name || item.name || "Line item"),
      description: cleanText(item.description),
      quantity: Number(item.quantity ?? 1) || Number(cleanText(item.quantity).replace(/[^0-9.]/g, "")) || 1,
      unit: cleanText(item.unit || "ea"),
      unit_price_cents: moneyCents(item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice),
      amount_cents: roundCents(item.amount_cents),
      included: item.included === true,
      optional: cleanText(selection.mode) === "optional" || cleanText(selection.mode) === "choice",
      selected: item.selected !== false,
      selectable_by: asArray(selection.selectable_by).map(cleanText).filter(Boolean),
      group_id: cleanText(selection.group_id),
      media: showMedia
        ? asArray(item.media_refs).map(asObject).map((ref) => ({
            media_id: cleanText(ref.media_id || ref.mediaId || ref.id),
            variant: cleanText(ref.variant) || "thumb_320",
            url: mediaRefUrl(ctx, { ...ref, variant: cleanText(ref.variant) || "thumb_320" })
          })).filter((ref) => ref.media_id || ref.url)
        : []
    };
  });
  // Top-level rows already include their children's totals (scopeItemPriceResult
  // sums the subtree), so the subtotal only counts depth-0 rows.
  const subtotalCents = rows.reduce((sum, row) => sum + (row.depth === 0 && row.selected && !row.included ? row.amount_cents : 0), 0);
  const taxPercent = Math.max(0, Number(config.tax_percent ?? ctx.params.tax_percent ?? 0) || 0);
  const taxCents = Math.round(subtotalCents * (taxPercent / 100));
  const columns = asArray(config.columns).map(cleanText).filter(Boolean);
  return {
    rows,
    totals: {
      subtotal_cents: subtotalCents,
      tax_cents: taxCents,
      tax_percent: taxPercent,
      total_cents: subtotalCents + taxCents,
      currency: cleanText(config.currency || ctx.params.currency || "USD") || "USD"
    },
    columns: columns.length ? columns : ["name", "description", "qty", "unit_price", "amount"]
  };
}, { title: "Line items", category: "data" });

// ---------------------------------------------------------------------------
// doc.payment_schedule — params.payment_schedule first, live payment
// obligations for the project as the fallback.
// ---------------------------------------------------------------------------

/**
 * Basis for resolving percent schedule rows in a render: the same depth-0
 * selected-row math doc.line_items totals with, plus params.tax_percent —
 * matching how the checkout pricing engine totals the document.
 */
function scheduleBasisTotalCents(ctx: WidgetResolveContext) {
  const items = asArray(ctx.params.scope_items).map((item, index) => normalizeScopeItem(item, index));
  if (!items.length) return Math.max(0, roundCents(ctx.params.amount_cents));
  const flattened = scopeItemsForView({ root_items: items }, {
    root_item_id: "root",
    render_depth: 0,
    show_included_items: false,
    show_unselected_options: false
  });
  const subtotal = flattened.reduce((sum, item) => {
    if (Number(item.depth || 0) !== 0 || item.selected === false || item.included === true) return sum;
    return sum + roundCents(item.amount_cents);
  }, 0);
  const taxPercent = Math.max(0, Number(ctx.params.tax_percent ?? 0) || 0);
  return subtotal + Math.round(subtotal * taxPercent / 100);
}

function scheduleRowsFromParams(ctx: WidgetResolveContext, value: unknown) {
  const rows = normalizeScheduleRows(value);
  if (!rows.length) return [];
  const resolved = resolveScheduleItems(rows, { total_cents: scheduleBasisTotalCents(ctx) });
  return resolved.map((item, index) => ({
    id: cleanText(item.id) || `schedule_${index + 1}`,
    label: item.label,
    amount_cents: item.amount_cents,
    due_rule: cleanText(item.due_rule),
    due_at: cleanText(item.due_at),
    status: "scheduled",
    allocated_cents: 0,
    balance_due_cents: item.amount_cents,
    ...(item.amount_expression ? { amount_expression: item.amount_expression, variable: true } : {})
  })).filter((row) => row.label || row.amount_cents > 0);
}

registerDocumentWidgetResolver("doc.payment_schedule", async (ctx, config) => {
  const fromParams = scheduleRowsFromParams(ctx, paramsPathValue(ctx, config.source, "params.payment_schedule"));
  let rows = fromParams;
  if (!rows.length) {
    const projectId = cleanText(ctx.document.project_id || asObject(ctx.project).id);
    if (!projectId) return null;
    const obligations = await ctx.services.payments.listProjectObligations(ctx.organizationId, projectId).catch(() => [] as JsonObject[]);
    rows = obligations
      .filter((item) => cleanText(item.direction || "inbound") !== "outbound")
      .map((item, index) => ({
        id: cleanText(item.id) || `obligation_${index + 1}`,
        label: cleanText(item.label || "Payment"),
        amount_cents: roundCents(item.amount_cents),
        due_rule: cleanText(item.due_rule),
        due_at: cleanText(item.due_at),
        status: cleanText(item.status || "open") || "open",
        allocated_cents: roundCents(item.allocated_cents),
        balance_due_cents: Math.max(0, roundCents(item.amount_cents) - roundCents(item.allocated_cents))
      }));
  }
  if (!rows.length) return null;
  return {
    rows,
    total_cents: rows.reduce((sum, row) => sum + row.amount_cents, 0),
    paid_cents: rows.reduce((sum, row) => sum + row.allocated_cents, 0),
    currency: cleanText(config.currency || "USD") || "USD"
  };
}, { title: "Payment schedule", category: "commerce" });

// ---------------------------------------------------------------------------
// Money report widgets — the data layer for report documents (job cost /
// financial reports generated from the Money tab). Each resolver pulls the
// same server-side summaries the Money tab renders, so a report PDF can never
// disagree with the live tab. All three degrade to null (widget placeholder)
// when the org's money capability is off or the document has no project.
// ---------------------------------------------------------------------------

async function reportMoneySummary(ctx: WidgetResolveContext) {
  const projectId = cleanText(ctx.document.project_id || asObject(ctx.project).id);
  if (!projectId) return null;
  try {
    const { projectMoneySummary } = await import("../../payments/storage.js");
    return await projectMoneySummary(ctx.organizationId, projectId);
  } catch {
    return null;
  }
}

registerDocumentWidgetResolver("doc.money_metrics", async (ctx, config) => {
  const summary = await reportMoneySummary(ctx);
  if (!summary) return null;
  const changeOrderCents = asArray(summary.obligations).map(asObject)
    .filter((item) => cleanText(item.kind) === "change_order" && cleanText(item.status) !== "void")
    .reduce((sum, item) => sum + Math.max(0, roundCents(item.amount_cents)), 0);
  const revenue = roundCents(summary.projected_revenue_cents);
  const forecastProfit = roundCents(summary.forecast_profit_cents);
  const metrics = [
    { key: "contract_value", label: "Contract Value", amount_cents: revenue },
    { key: "change_orders", label: "Change Orders", amount_cents: changeOrderCents },
    { key: "collected", label: "Collected", amount_cents: roundCents(summary.total_collected_cents) },
    { key: "balance", label: "Balance Remaining", amount_cents: roundCents(summary.total_remaining_cents) },
    { key: "cost_forecast", label: "Cost Forecast", amount_cents: roundCents(summary.forecast_expenses_cents) },
    { key: "expenses_to_date", label: "Expenses To Date", amount_cents: roundCents(summary.expenses_to_date_cents) },
    { key: "forecast_profit", label: "Forecast Profit", amount_cents: forecastProfit },
    { key: "profit_to_date", label: "Profit To Date", amount_cents: roundCents(summary.profit_to_date_cents) }
  ];
  const requested = asArray(config.keys).map(cleanText).filter(Boolean);
  return {
    metrics: requested.length ? metrics.filter((metric) => requested.includes(metric.key)) : metrics,
    margin_bps: revenue > 0 ? Math.round(forecastProfit * 10_000 / revenue) : 0,
    currency: "USD",
    generated_at: new Date().toISOString()
  };
}, { title: "Money metrics", category: "reports" });

registerDocumentWidgetResolver("doc.expense_breakdown", async (ctx, config) => {
  const projectId = cleanText(ctx.document.project_id || asObject(ctx.project).id);
  if (!projectId) return null;
  let summary: JsonObject;
  try {
    const { projectExpenseSummary } = await import("../../payments/expenses.js");
    summary = asObject(await projectExpenseSummary(ctx.organizationId, projectId));
  } catch {
    return null;
  }
  const groups = asArray(summary.groups).map(asObject);
  const rows = groups.map((group) => {
    const types = [...new Set(asArray(group.targets).map(asObject).map((target) => cleanText(target.resource_type)).filter(Boolean))];
    return {
      title: cleanText(group.title || "Expense"),
      resource_type: types.length === 1 ? types[0] : (types.length ? "mixed" : "other"),
      projected_cents: roundCents(group.projected_cents),
      actual_cents: group.actual_cents == null ? null : roundCents(group.actual_cents),
      current_cents: roundCents(group.current_cents),
      variance_cents: roundCents(group.current_cents) - roundCents(group.projected_cents),
      system_managed: group.system_managed === true
    };
  }).filter((row) => row.projected_cents > 0 || (row.actual_cents ?? 0) > 0 || row.current_cents > 0);
  if (!rows.length) return null;
  const totals = asObject(summary.totals);
  return {
    rows: config.include_system === false ? rows.filter((row) => !row.system_managed) : rows,
    by_resource: asObject(summary.by_resource),
    totals: {
      projected_cents: roundCents(totals.projected_cents),
      actual_cents: roundCents(totals.actual_cents),
      current_cents: roundCents(totals.current_cents),
      variance_cents: roundCents(totals.variance_cents)
    },
    currency: "USD"
  };
}, { title: "Expense breakdown", category: "reports" });

function withinReportPeriod(ctx: WidgetResolveContext, at: string) {
  const from = cleanText(ctx.params.period_from);
  const to = cleanText(ctx.params.period_to);
  if (!from && !to) return true;
  const stamp = Date.parse(cleanText(at));
  if (!Number.isFinite(stamp)) return true;
  if (from && Number.isFinite(Date.parse(from)) && stamp < Date.parse(from)) return false;
  // period_to is a date (inclusive) — extend to the end of that day.
  if (to && Number.isFinite(Date.parse(to)) && stamp >= Date.parse(to) + 86_400_000) return false;
  return true;
}

registerDocumentWidgetResolver("doc.payment_history", async (ctx, config) => {
  const summary = await reportMoneySummary(ctx);
  if (!summary) return null;
  const includeOutbound = config.include_outbound !== false;
  const payments = asArray(summary.payments).map(asObject)
    .filter((payment) => ["settled", "partially_refunded", "refunded"].includes(cleanText(payment.status)))
    .filter((payment) => includeOutbound || cleanText(payment.direction) !== "outbound")
    .filter((payment) => withinReportPeriod(ctx, cleanText(payment.received_at || payment.settled_at || payment.created_at)))
    .sort((a, b) => cleanText(a.received_at || a.created_at).localeCompare(cleanText(b.received_at || b.created_at)))
    .map((payment) => ({
      id: cleanText(payment.id),
      direction: cleanText(payment.direction || "inbound") || "inbound",
      kind: cleanText(payment.kind),
      method: cleanText(asObject(payment.method).type || asObject(payment.method).kind),
      amount_cents: roundCents(payment.amount_cents),
      received_at: cleanText(payment.received_at || payment.created_at),
      cleared_at: cleanText(payment.cleared_at),
      status: cleanText(payment.status)
    }));
  if (!payments.length) return null;
  const totalIn = payments.filter((p) => p.direction === "inbound").reduce((sum, p) => sum + p.amount_cents, 0);
  const totalOut = payments.filter((p) => p.direction === "outbound").reduce((sum, p) => sum + p.amount_cents, 0);
  return { rows: payments, totals: { inbound_cents: totalIn, outbound_cents: totalOut, net_cents: totalIn - totalOut }, currency: "USD" };
}, { title: "Payment history", category: "reports" });

registerDocumentWidgetResolver("doc.report_table", async (ctx, config) => {
  const columns = asArray(paramsPathValue(ctx, config.columns, "params.columns")).map(asObject)
    .map((column) => ({ key: cleanText(column.key), label: cleanText(column.label || column.key) }))
    .filter((column) => column.key);
  const rows = asArray(paramsPathValue(ctx, config.rows, "params.rows")).map(asObject);
  return { columns, rows };
}, { title: "Report table", category: "reports" });

// ---------------------------------------------------------------------------
// doc.pay_now — amount-due summary (static render is a summary + portal link;
// interactive payment capture happens client-side through the portal).
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("doc.pay_now", async (ctx, config) => {
  const projectId = cleanText(ctx.document.project_id || asObject(ctx.project).id);
  const configuredAmountPath = cleanText(config.source);
  let amountDueCents = 0;
  let label = cleanText(config.label || "Amount due");
  let obligationId = "";
  if (configuredAmountPath) {
    const configuredAmount = paramsPathValue(ctx, configuredAmountPath, "params.deposit_cents");
    amountDueCents = Math.max(0, /_cents$/i.test(configuredAmountPath) ? roundCents(configuredAmount) : moneyCents(configuredAmount));
  }
  if (!configuredAmountPath && projectId) {
    const obligations = await ctx.services.payments.listProjectObligations(ctx.organizationId, projectId).catch(() => [] as JsonObject[]);
    const open = obligations
      .filter((item) => cleanText(item.direction || "inbound") !== "outbound")
      .map((item) => ({
        id: cleanText(item.id),
        label: cleanText(item.label || "Payment"),
        balance: Math.max(0, roundCents(item.amount_cents) - roundCents(item.allocated_cents))
      }))
      .filter((item) => item.balance > 0);
    const deposit = open.find((item) => /deposit/i.test(item.label)) || open[0];
    if (deposit) {
      amountDueCents = deposit.balance;
      label = cleanText(config.label) || deposit.label;
      obligationId = deposit.id;
    }
  }
  if (!configuredAmountPath && !amountDueCents) {
    const configuredAmount = paramsPathValue(ctx, "params.deposit_cents", "params.deposit_cents");
    amountDueCents = Math.max(0, roundCents(configuredAmount));
  }
  // A template-level percentage schedule is authoritative when there are no
  // minted obligations yet (the normal pre-signature proposal state). Resolve
  // it against the exact same contract basis as doc.payment_schedule and pick
  // the signature/deposit milestone, so Pay never falls through to $0.00.
  if (!configuredAmountPath && !amountDueCents) {
    const scheduled = resolveScheduleItems(normalizeScheduleRows(ctx.params.payment_schedule), {
      total_cents: scheduleBasisTotalCents(ctx)
    });
    const due = scheduled.find((item) => item.due_rule === "on_signature" && item.amount_cents > 0)
      || scheduled.find((item) => item.payment_kind === "deposit" && item.amount_cents > 0)
      || scheduled.find((item) => item.amount_cents > 0);
    if (due) {
      amountDueCents = due.amount_cents;
      label = cleanText(config.label) || due.label;
    }
  }
  if (!amountDueCents) return null;
  return {
    amount_due_cents: amountDueCents,
    label,
    currency: cleanText(config.currency || "USD") || "USD",
    obligation_id: obligationId,
    portal_url: publicDocumentPortalUrl(documentPublicToken(ctx))
  };
}, { title: "Pay now", category: "commerce" });

// ---------------------------------------------------------------------------
// doc.photo / doc.photo_grid — resolve media references to file URLs.
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("doc.photo", async (ctx, config) => {
  const configured = asObject(config.media);
  const fromParams = asObject(paramsPathValue(ctx, config.source, "params.hero_photo"));
  const ref = Object.keys(configured).length ? configured : fromParams;
  const url = mediaRefUrl(ctx, ref);
  if (!url) return null;
  const dataUri = await mediaRefDataUri(ctx, ref);
  return {
    media_id: cleanText(ref.media_id || ref.mediaId || ref.id),
    variant: cleanText(ref.variant) || "original",
    url,
    ...(dataUri ? { data_uri: dataUri } : {}),
    alt: cleanText(config.alt || ref.alt),
    caption: cleanText(config.caption || ref.caption),
    markup_layer_id: cleanText(ref.markup_layer_id || ref.markupLayerId)
  };
}, { title: "Photo", category: "media" });

registerDocumentWidgetResolver("doc.photo_grid", async (ctx, config) => {
  let refs = asArray(config.items).map(asObject);
  if (!refs.length) refs = asArray(paramsPathValue(ctx, config.source, "params.photos")).map(asObject);
  if (!refs.length) refs = asArray(asObject(ctx.project).photos).map(asObject);
  const limit = Math.max(1, Math.round(Number(config.limit ?? 8)) || 8);
  const items = await Promise.all(refs.slice(0, limit).map(async (ref) => {
    const variantRef = { ...ref, variant: cleanText(ref.variant) || "thumb_640" };
    const dataUri = await mediaRefDataUri(ctx, variantRef);
    return {
      media_id: cleanText(ref.media_id || ref.mediaId || ref.id),
      variant: cleanText(ref.variant) || "thumb_640",
      url: mediaRefUrl(ctx, variantRef),
      ...(dataUri ? { data_uri: dataUri } : {}),
      caption: cleanText(ref.caption || ref.title),
      markup_layer_id: cleanText(ref.markup_layer_id || ref.markupLayerId)
    };
  }));
  const usable = items.filter((item) => item.url);
  return usable.length ? { items: usable, columns: Math.max(1, Math.round(Number(config.columns ?? 2)) || 2) } : null;
}, { title: "Photo grid", category: "media" });

// ---------------------------------------------------------------------------
// doc.measurement_report — pass params.measurements through with a light
// summary so templates can render a measurement table without custom math.
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("doc.measurement_report", async (ctx, config) => {
  const measurements = paramsPathValue(ctx, config.source, "params.measurements");
  const source = asObject(measurements);
  if (!Object.keys(source).length) return null;
  const labels: Record<string, string> = {
    roofSquares: "Roof area (squares)",
    roof_squares: "Roof area (squares)",
    eavesLf: "Eaves (lf)",
    eaves_lf: "Eaves (lf)",
    ridgeLf: "Ridge (lf)",
    valleysLf: "Valleys (lf)",
    rakesLf: "Rakes (lf)",
    pitch: "Predominant pitch"
  };
  const rows = Object.entries(source)
    .filter(([, value]) => typeof value === "number" || typeof value === "string")
    .map(([key, value]) => ({
      key,
      label: labels[key] || cleanText(key).replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()),
      value: typeof value === "number" ? value : cleanText(value)
    }))
    .filter((row) => row.value !== "");
  if (!rows.length) return null;
  return { rows, measurements: source };
}, { title: "Measurement report", category: "data" });

// ---------------------------------------------------------------------------
// doc.signature — echoes recorded output state so the static renderer can
// show either the signed image/text or a blank line.
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("doc.signature", async (ctx, config) => {
  const outputKey = cleanText(config.output || config.output_key) || "sig_customer";
  const outputs = asObject(ctx.snapshot ? asObject(ctx.snapshot).outputs : ctx.document.outputs);
  const outputDefs = asObject(ctx.document.output_defs);
  const def = asObject(outputDefs[outputKey]);
  const value = asObject(outputs[outputKey]);
  const signed = !!cleanText(value.signed_at);
  return {
    output_key: outputKey,
    label: cleanText(config.label || def.label || "Signature"),
    signer: cleanText(config.signer || def.signer || "customer") || "customer",
    required: def.required === true,
    signed,
    signature: signed
      ? {
          type: cleanText(value.type || "typed") || "typed",
          text: cleanText(value.text || value.signer_name),
          signer_name: cleanText(value.signer_name || value.text),
          style: cleanText(value.style || "style-classic") || "style-classic",
          image_data: cleanText(value.image_data),
          signed_at: cleanText(value.signed_at)
        }
      : null
  };
}, { title: "Signature", category: "input" });

// ---------------------------------------------------------------------------
// doc.qr — compute the target URL only; QR encoding is local in the client
// widget (no external services).
// ---------------------------------------------------------------------------

registerDocumentWidgetResolver("doc.qr", async (ctx, config) => {
  const url = cleanText(config.url) || publicDocumentPortalUrl(documentPublicToken(ctx));
  if (!url) return null;
  return { url, label: cleanText(config.label) };
}, { title: "QR code", category: "data" });

/** Importing this module registers every built-in server resolver. */
export function registerBuiltinDocumentWidgetResolvers() {
  // Registration happens at module load; this export exists so callers can
  // express the dependency explicitly instead of relying on import order.
}
