import { mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { badRequest, notFound } from "../../platform/errors.js";
import { listOrganizations, patchOrganization, readGlobal, readOrganization } from "../../platform/storage.js";
import { asObject } from "./storage.js";

type JsonObject = Record<string, unknown>;

const REFERRAL_TABLES = new Set([
  "referral_partners",
  "referral_codes",
  "referral_attributions",
  "referral_reward_ledger",
  "referral_events"
]);

const ATTRIBUTION_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "cid",
  "xid",
  "acquisition_bonus_token",
  "acquisition_bonus_set_id",
  "acquisition_bonus_label",
  "fbclid",
  "_fbc",
  "_fbp",
  "landing_variant",
  "landing_page",
  "page_path",
  "page_search",
  "page_hash",
  "page_url",
  "referrer",
  "request_received_at",
  "request_ip",
  "client_ip",
  "forwarded_for",
  "forwarded_proto",
  "forwarded_host",
  "real_ip",
  "remote_address",
  "user_agent",
  "accept_language",
  "request_referrer",
  "origin",
  "host",
  "request_host",
  "request_protocol",
  "request_url",
  "cf_connecting_ip",
  "cf_ipcountry",
  "cf_region",
  "cf_city",
  "cf_postal_code",
  "cf_timezone",
  "x_vercel_ip_country",
  "x_vercel_ip_country_region",
  "x_vercel_ip_city",
  "x_vercel_ip_latitude",
  "x_vercel_ip_longitude",
  "x_appengine_country",
  "x_appengine_region",
  "x_appengine_city",
  "browser_user_agent",
  "browser_language",
  "browser_languages",
  "browser_platform",
  "browser_vendor",
  "browser_cookie_enabled",
  "browser_do_not_track",
  "timezone",
  "timezone_offset_minutes",
  "screen_width",
  "screen_height",
  "screen_available_width",
  "screen_available_height",
  "screen_color_depth",
  "screen_pixel_depth",
  "viewport_width",
  "viewport_height",
  "device_pixel_ratio",
  "touch_points",
  "hardware_concurrency",
  "device_memory",
  "connection_type",
  "connection_effective_type",
  "connection_downlink",
  "connection_rtt",
  "page_title",
  "page_loaded_at",
  "visibility_state",
  "history_length",
  "navigation_type",
  "page_load_ms",
  "dom_interactive_ms",
  "dom_content_loaded_ms"
];

const BONUS_QUERY_KEY = "xid";
const ACQUISITION_BONUS_OFFER_ID = "acquisition_bonus_offer_v1";
const DEFAULT_ACQUISITION_BONUS_TIERS = [
  { customer_pays: 50, match_percent: 0 },
  { customer_pays: 100, match_percent: 25 },
  { customer_pays: 200, match_percent: 50 }
];

export async function ensureReferralDatabase() {
  await mkdir(referralDatabaseDir(), { recursive: true });
  withReferralDb((db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS referral_partners (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'manufacturer_rep',
        status TEXT NOT NULL DEFAULT 'active',
        display_name TEXT NOT NULL DEFAULT '',
        company_name TEXT NOT NULL DEFAULT '',
        contact_name TEXT NOT NULL DEFAULT '',
        contact_email TEXT NOT NULL DEFAULT '',
        contact_phone TEXT NOT NULL DEFAULT '',
        linked_user_email TEXT NOT NULL DEFAULT '',
        linked_org_id TEXT NOT NULL DEFAULT '',
        logo_url TEXT NOT NULL DEFAULT '',
        logo_path TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS referral_codes (
        id TEXT PRIMARY KEY,
        partner_id TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL DEFAULT 'Primary',
        campaign_type TEXT NOT NULL DEFAULT '',
        landing_variant TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        active INTEGER NOT NULL DEFAULT 1,
        is_primary INTEGER NOT NULL DEFAULT 0,
        new_org_offer_id TEXT NOT NULL DEFAULT '',
        referrer_reward_policy_id TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        landing_views INTEGER NOT NULL DEFAULT 0,
        last_viewed_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS referral_attributions (
        id TEXT PRIMARY KEY,
        partner_id TEXT NOT NULL,
        code_id TEXT NOT NULL,
        referral_code TEXT NOT NULL DEFAULT '',
        referred_org_id TEXT NOT NULL DEFAULT '',
        referred_email TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'signup_completed',
        source TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        signup_completed_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS referral_reward_ledger (
        id TEXT PRIMARY KEY,
        attribution_id TEXT NOT NULL,
        partner_id TEXT NOT NULL,
        code_id TEXT NOT NULL DEFAULT '',
        reward_type TEXT NOT NULL DEFAULT 'gift_card',
        amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS referral_events (
        id TEXT PRIMARY KEY,
        partner_id TEXT NOT NULL DEFAULT '',
        code_id TEXT NOT NULL DEFAULT '',
        code TEXT NOT NULL DEFAULT '',
        actor_email TEXT NOT NULL DEFAULT '',
        actor_org_id TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL DEFAULT '',
        event_count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_referral_codes_partner ON referral_codes(partner_id);
      CREATE INDEX IF NOT EXISTS idx_referral_attributions_partner ON referral_attributions(partner_id);
      CREATE INDEX IF NOT EXISTS idx_referral_attributions_org ON referral_attributions(referred_org_id);
      CREATE INDEX IF NOT EXISTS idx_referral_rewards_attribution ON referral_reward_ledger(attribution_id);
    `);
  });
}

export function referralRows(table: string) {
  if (!REFERRAL_TABLES.has(table)) return [];
  return rows(`SELECT * FROM ${table} ORDER BY updated_at DESC LIMIT 500`);
}

export function listReferralPartners() {
  return rows("SELECT * FROM referral_partners ORDER BY updated_at DESC LIMIT 500").map((partner) => hydratePartner(partner));
}

export function listAcquisitionCampaigns() {
  return rows(`
    SELECT *
    FROM referral_partners
    WHERE type = 'acquisition_campaign'
    ORDER BY updated_at DESC
    LIMIT 500
  `).map((partner) => hydrateAcquisitionCampaign(partner));
}

export async function saveAcquisitionCampaign(input: JsonObject) {
  const now = nowIso();
  const name = String(input.display_name ?? input.name ?? input.campaign ?? "").trim();
  if (!name) throw badRequest("campaign_name_required", "Campaign name is required.");
  const existingId = String(input.id ?? "").trim();
  const existingPartnerById = existingId ? row("SELECT * FROM referral_partners WHERE id = :id LIMIT 1", { id: existingId }) : null;
  const existingPrimaryCode = existingId ? primaryCodeForPartner(existingId) : null;
  const codeInput = firstNonBlank(input.code, input.campaign_code, input.acquisition_code, input.campaign, existingPrimaryCode?.code, name);
  const codeValue = acquisitionCodeValue(codeInput);
  const existingByCode = referralCodeByCode(codeValue, false);
  const id = existingId || String(existingByCode?.partner_id ?? "") || `acq_${slugify(codeValue).slice(0, 48) || "marketing"}`;
  const existingPartner = existingPartnerById ?? row("SELECT * FROM referral_partners WHERE id = :id LIMIT 1", { id });
  const linkedCode = existingByCode && String(existingByCode.partner_id ?? "") !== id ? existingByCode : null;
  if (linkedCode) throw badRequest("campaign_code_in_use", "That campaign code is already assigned to another campaign.");
  const existingMetadata = asObject(existingPartner?.metadata);
  const inputMetadata = asObject(input.metadata);
  const hasBonusInput = Object.prototype.hasOwnProperty.call(input, "bonus_offer_sets")
    || Object.prototype.hasOwnProperty.call(input, "bonusOffers")
    || Object.prototype.hasOwnProperty.call(input, "bonus_offers")
    || Object.prototype.hasOwnProperty.call(inputMetadata, "bonus_offer_sets");
  const bonusOfferSets = normalizeBonusOfferSets(
    hasBonusInput ? (input.bonus_offer_sets ?? input.bonusOffers ?? input.bonus_offers ?? inputMetadata.bonus_offer_sets) : existingMetadata.bonus_offer_sets,
    asObject(existingMetadata.bonus_offer_state),
    asObject(existingMetadata.bonus_offer_sets)
  );

  const metadata = {
    ...existingMetadata,
    ...inputMetadata,
    source_type: "marketing",
    campaign: codeInput,
    channel: String(input.channel ?? input.campaign_type ?? "").trim(),
    landing_page: String(input.landing_page ?? "").trim(),
    landing_page_path: String(input.landing_page_path ?? input.landing_page ?? "").trim(),
    landing_variant: String(input.landing_variant ?? "").trim(),
    notes: String(input.notes ?? "").trim(),
    bonus_offer_sets: bonusOfferSets,
    bonus_offer_state: mergeBonusOfferState(asObject(existingMetadata.bonus_offer_state), bonusOfferSets)
  };
  const partner = {
    id,
    type: "acquisition_campaign",
    status: normalizePartnerStatus(input.status),
    display_name: name,
    company_name: String(input.channel ?? input.campaign_type ?? "").trim(),
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    linked_user_email: "",
    linked_org_id: "",
    logo_url: "",
    logo_path: "",
    notes: String(input.notes ?? "").trim(),
    metadata_json: JSON.stringify(metadata),
    created_at: String(existingPartner?.created_at ?? now),
    updated_at: now
  };
  withReferralDb((db) => {
    db.prepare(`
      INSERT INTO referral_partners (
        id, type, status, display_name, company_name, contact_name, contact_email, contact_phone,
        linked_user_email, linked_org_id, logo_url, logo_path, notes, metadata_json, created_at, updated_at
      ) VALUES (
        :id, :type, :status, :display_name, :company_name, :contact_name, :contact_email, :contact_phone,
        :linked_user_email, :linked_org_id, :logo_url, :logo_path, :notes, :metadata_json, :created_at, :updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        display_name = excluded.display_name,
        company_name = excluded.company_name,
        notes = excluded.notes,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(partner as any);
  });

  const existingCode = existingPrimaryCode && existingId === id ? existingPrimaryCode : primaryCodeForPartner(id);
  const codeRecord = {
    id: String(existingCode?.id ?? generateId("acqlink")),
    partner_id: id,
    code: codeValue,
    label: String(input.label ?? existingCode?.label ?? "Primary"),
    campaign_type: String(input.campaign_type ?? input.channel ?? existingCode?.campaign_type ?? "marketing").trim() || "marketing",
    landing_variant: String(input.landing_variant ?? existingCode?.landing_variant ?? "").trim(),
    status: normalizePartnerStatus(input.status),
    active: normalizePartnerStatus(input.status) === "active" ? 1 : 0,
    is_primary: 1,
    new_org_offer_id: "",
    referrer_reward_policy_id: "",
    metadata_json: JSON.stringify({
      ...asObject(existingCode?.metadata),
      source_type: "marketing",
      campaign: codeInput,
      channel: String(input.channel ?? input.campaign_type ?? "").trim(),
      landing_page: String(input.landing_page ?? "").trim(),
      landing_page_path: String(input.landing_page_path ?? input.landing_page ?? "").trim(),
      bonus_offer_sets: bonusOfferSets
    }),
    landing_views: Number(existingCode?.landing_views ?? 0),
    last_viewed_at: String(existingCode?.last_viewed_at ?? ""),
    created_at: String(existingCode?.created_at ?? now),
    updated_at: now
  };
  withReferralDb((db) => {
    db.prepare(`
      INSERT INTO referral_codes (
        id, partner_id, code, label, campaign_type, landing_variant, status, active, is_primary,
        new_org_offer_id, referrer_reward_policy_id, metadata_json, landing_views, last_viewed_at, created_at, updated_at
      ) VALUES (
        :id, :partner_id, :code, :label, :campaign_type, :landing_variant, :status, :active, :is_primary,
        :new_org_offer_id, :referrer_reward_policy_id, :metadata_json, :landing_views, :last_viewed_at, :created_at, :updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code,
        label = excluded.label,
        campaign_type = excluded.campaign_type,
        landing_variant = excluded.landing_variant,
        status = excluded.status,
        active = excluded.active,
        is_primary = excluded.is_primary,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(codeRecord as any);
  });
  return {
    ok: true,
    success: true,
    campaign: hydrateAcquisitionCampaign({ ...partner, metadata: asObject(metadata) }),
    link: normalizeRow(codeRecord),
    signup_url: acquisitionSignupUrl(codeRecord.code)
  };
}

export async function acquisitionCampaignReport(input: JsonObject) {
  const campaignId = String(input.campaign_id ?? input.partner_id ?? input.id ?? "all").trim() || "all";
  const timezoneOffsetMinutes = normalizeTimezoneOffset(input.timezone_offset_minutes ?? input.timezone_offset ?? input.tz_offset);
  const range = reportRange(input, timezoneOffsetMinutes);
  const campaignRows = campaignId === "all"
    ? listAcquisitionCampaigns()
    : rows("SELECT * FROM referral_partners WHERE id = :id AND type = 'acquisition_campaign' LIMIT 1", { id: campaignId }).map((partner) => hydrateAcquisitionCampaign(partner));
  const campaignIds = new Set(campaignRows.map((campaign) => String(campaign.id ?? "")));
  if (campaignId !== "all" && !campaignIds.size) throw notFound("campaign_not_found", "Campaign was not found.");

  const attributionRows = rows(`
    SELECT ra.*, rp.display_name AS campaign_name, rc.campaign_type, rc.landing_variant, rc.landing_views
    FROM referral_attributions ra
    LEFT JOIN referral_partners rp ON rp.id = ra.partner_id
    LEFT JOIN referral_codes rc ON rc.id = ra.code_id
    WHERE rp.type = 'acquisition_campaign'
    ORDER BY ra.created_at ASC
    LIMIT 20000
  `).filter((entry) => campaignIds.has(String(entry.partner_id ?? "")));
  const eventRows = rows(`
    SELECT re.*, rp.display_name AS campaign_name
    FROM referral_events re
    LEFT JOIN referral_partners rp ON rp.id = re.partner_id
    WHERE rp.type = 'acquisition_campaign'
    ORDER BY re.created_at ASC
    LIMIT 20000
  `).filter((entry) => campaignIds.has(String(entry.partner_id ?? "")));

  const viewsInRange = attributionRows.filter((entry) => inRange(String(entry.created_at ?? ""), range));
  const signupsInRange = attributionRows.filter((entry) => String(entry.status ?? "") === "signup_completed" && inRange(String(entry.signup_completed_at || entry.updated_at || entry.created_at || ""), range));
  const orgIds = [...new Set(attributionRows
    .filter((entry) => String(entry.status ?? "") === "signup_completed")
    .map((entry) => String(entry.referred_org_id ?? "").trim())
    .filter(Boolean))];
  const orgSpend = await spendForOrganizations(orgIds, range);
  const spendByOrg = new Map(orgSpend.organizations.map((entry) => [entry.org_id, entry]));
  const spendTotal = orgSpend.total_spend;
  const uniqueVisitorCount = uniqueVisitorCountForRows(viewsInRange);

  const daily = buildDailyTrend(range, viewsInRange, signupsInRange, orgSpend.ledger, timezoneOffsetMinutes);
  const hourly = buildHourlyTrend(viewsInRange, signupsInRange, orgSpend.ledger, timezoneOffsetMinutes);
  const sources = breakdown(attributionRows.filter((entry) => inRange(String(entry.created_at ?? ""), range)), acquisitionSourceLabel);
  const landingPages = breakdown(attributionRows.filter((entry) => inRange(String(entry.created_at ?? ""), range)), (entry) => String(asObject(entry.metadata).landing_page || asObject(entry.metadata).landing_page_path || entry.landing_variant || "unknown"));
  const browsers = breakdown(attributionRows.filter((entry) => inRange(String(entry.created_at ?? ""), range)), (entry) => browserFamily(String(asObject(entry.metadata).browser_user_agent || asObject(entry.metadata).user_agent || "")));
  const countries = breakdown(attributionRows.filter((entry) => inRange(String(entry.created_at ?? ""), range)), (entry) => String(asObject(entry.metadata).cf_ipcountry || asObject(entry.metadata).x_vercel_ip_country || asObject(entry.metadata).x_appengine_country || "unknown"));
  const cities = breakdown(attributionRows.filter((entry) => inRange(String(entry.created_at ?? ""), range)), (entry) => String(asObject(entry.metadata).x_vercel_ip_city || asObject(entry.metadata).cf_city || asObject(entry.metadata).x_appengine_city || "unknown"));
  const devices = breakdown(attributionRows.filter((entry) => inRange(String(entry.created_at ?? ""), range)), (entry) => deviceClass(asObject(entry.metadata)));
  const timezones = breakdown(attributionRows.filter((entry) => inRange(String(entry.created_at ?? ""), range)), (entry) => String(asObject(entry.metadata).timezone || asObject(entry.metadata).cf_timezone || "unknown"));
  const languages = breakdown(attributionRows.filter((entry) => inRange(String(entry.created_at ?? ""), range)), (entry) => String(asObject(entry.metadata).browser_language || asObject(entry.metadata).accept_language || "unknown").split(",")[0] || "unknown");
  const bonusOffers = bonusOfferBreakdown(campaignRows, viewsInRange, signupsInRange, spendByOrg);
  const campaignBreakdown = campaignRows.map((campaign) => {
    const id = String(campaign.id ?? "");
    const campaignViews = viewsInRange.filter((entry) => String(entry.partner_id ?? "") === id);
    const viewCount = campaignViews.length;
    const uniqueVisitors = uniqueVisitorCountForRows(campaignViews);
    const signupRows = signupsInRange.filter((entry) => String(entry.partner_id ?? "") === id);
    const spend = signupRows.reduce((sum, entry) => sum + Number(spendByOrg.get(String(entry.referred_org_id ?? ""))?.spend ?? 0), 0);
    return {
      id,
      name: String(campaign.display_name ?? ""),
      code: String(asObject(campaign.primary_code).code ?? ""),
      landing_page: String(asObject(campaign.metadata).landing_page || asObject(asObject(campaign.primary_code).metadata).landing_page || ""),
      views: viewCount,
      unique_visitors: uniqueVisitors,
      signups: signupRows.length,
      spend,
      conversion_rate: uniqueVisitors ? signupRows.length / uniqueVisitors : 0
    };
  }).sort((a, b) => b.spend - a.spend || b.signups - a.signups || b.views - a.views);
  const campaignBreakdownById = new Map(campaignBreakdown.map((entry) => [entry.id, entry]));
  const reportCampaignRows = campaignRows.map((campaign) => {
    const stats = campaignBreakdownById.get(String(campaign.id ?? ""));
    return {
      ...campaign,
      stats: {
        ...asObject(campaign.stats),
        total_views: Number(stats?.views ?? 0),
        total_unique_visitors: Number(stats?.unique_visitors ?? 0),
        total_signups: Number(stats?.signups ?? 0),
        total_spend: Number(stats?.spend ?? 0),
        conversion_rate: Number(stats?.conversion_rate ?? 0)
      },
      report_stats: stats ?? {
        id: String(campaign.id ?? ""),
        name: String(campaign.display_name ?? ""),
        code: String(asObject(campaign.primary_code).code ?? ""),
        landing_page: String(asObject(campaign.metadata).landing_page || asObject(asObject(campaign.primary_code).metadata).landing_page || ""),
        views: 0,
        unique_visitors: 0,
        signups: 0,
        spend: 0,
        conversion_rate: 0
      }
    };
  });

  return {
    ok: true,
    success: true,
    range: {
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      timezone_offset_minutes: timezoneOffsetMinutes
    },
    selected_campaign_id: campaignId,
    campaigns: reportCampaignRows,
    summary: {
      campaigns: campaignRows.length,
      views: viewsInRange.length,
      unique_visitors: uniqueVisitorCount,
      repeat_views: Math.max(0, viewsInRange.length - uniqueVisitorCount),
      signups: signupsInRange.length,
      spend: spendTotal,
      average_spend_per_signup: signupsInRange.length ? spendTotal / signupsInRange.length : 0,
      conversion_rate: uniqueVisitorCount ? signupsInRange.length / uniqueVisitorCount : 0,
      events: eventRows.filter((entry) => inRange(String(entry.created_at ?? ""), range)).reduce((sum, entry) => sum + Number(entry.event_count ?? 1), 0)
    },
    daily,
    hourly,
      sources,
      landing_pages: landingPages,
      browsers,
      countries,
      cities,
      devices,
      timezones,
      languages,
      bonus_offers: bonusOffers,
    campaign_breakdown: campaignBreakdown,
    recent_signups: signupsInRange.slice(-40).reverse().map((entry) => ({
      attribution_id: String(entry.id ?? ""),
      campaign_id: String(entry.partner_id ?? ""),
      campaign_name: String(entry.campaign_name ?? ""),
      org_id: String(entry.referred_org_id ?? ""),
      email: String(entry.referred_email ?? ""),
      signed_up_at: String(entry.signup_completed_at || entry.updated_at || ""),
      spend: Number(spendByOrg.get(String(entry.referred_org_id ?? ""))?.spend ?? 0),
      metadata: asObject(entry.metadata)
    })),
    spend_ledger: orgSpend.ledger.slice(-500).reverse(),
    raw: {
      campaigns: reportCampaignRows.map(rawCampaignRow),
      attributions: viewsInRange.slice(-5000).reverse().map(rawAttributionRow),
      signups: signupsInRange.slice(-5000).reverse().map((entry) => rawSignupRow(entry, spendByOrg)),
      events: eventRows.filter((entry) => inRange(String(entry.created_at ?? ""), range)).slice(-5000).reverse().map(rawEventRow),
      bonus_offers: bonusOffers,
      spend_ledger: orgSpend.ledger.slice(-5000).reverse()
    }
  };
}

function browserFamily(userAgent: string) {
  const ua = String(userAgent || "").toLowerCase();
  if (!ua) return "unknown";
  if (ua.includes("edg/") || ua.includes("edge/")) return "Edge";
  if (ua.includes("opr/") || ua.includes("opera")) return "Opera";
  if (ua.includes("chrome/") && !ua.includes("chromium")) return "Chrome";
  if (ua.includes("safari/") && !ua.includes("chrome/")) return "Safari";
  if (ua.includes("firefox/")) return "Firefox";
  if (ua.includes("bot") || ua.includes("crawler") || ua.includes("spider")) return "Bot";
  return "Other";
}

function acquisitionSourceLabel(entry: JsonObject) {
  const metadata = asObject(entry.metadata);
  const explicitSource = firstNonBlank(metadata.utm_source, marketingSourceValue(metadata.source));
  if (explicitSource) return sourceTitle(String(explicitSource));
  if (metadata.fbclid || metadata._fbp || metadata._fbc) return "Facebook";

  const referrer = String(firstNonBlank(metadata.referrer, metadata.request_referrer) ?? "").trim();
  if (referrer) {
    try {
      const host = new URL(referrer).hostname.replace(/^www\./, "");
      const pageHost = pageUrlHost(metadata);
      if (host && host !== pageHost) return host;
    } catch {
      return referrer;
    }
  }

  const backendSource = String(entry.source ?? "").trim();
  if (backendSource && backendSource !== "public_acquisition_lookup") return sourceTitle(backendSource);
  return "Direct / no UTM";
}

function marketingSourceValue(value: unknown) {
  const source = String(value ?? "").trim();
  if (!source || source === "public_acquisition_lookup") return "";
  return source;
}

function pageUrlHost(metadata: JsonObject) {
  const pageUrl = String(firstNonBlank(metadata.page_url, metadata.origin) ?? "").trim();
  if (!pageUrl) return "";
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sourceTitle(value: string) {
  return String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function deviceClass(metadata: JsonObject) {
  const platform = String(metadata.browser_platform || metadata.sec_ch_ua_platform || "").toLowerCase();
  const ua = String(metadata.browser_user_agent || metadata.user_agent || "").toLowerCase();
  const width = Number(metadata.viewport_width || metadata.screen_width || 0);
  if (ua.includes("bot") || ua.includes("crawler") || ua.includes("spider")) return "Bot";
  if (ua.includes("ipad") || ua.includes("tablet") || (platform.includes("mac") && Number(metadata.touch_points || 0) > 1)) return "Tablet";
  if (ua.includes("mobile") || ua.includes("iphone") || ua.includes("android") || (width > 0 && width < 700)) return "Mobile";
  if (platform || ua || width) return "Desktop";
  return "unknown";
}

function rawCampaignRow(campaign: JsonObject) {
  const code = asObject(campaign.primary_code);
  const metadata = { ...asObject(campaign.metadata), ...asObject(code.metadata) };
  return {
    id: String(campaign.id ?? ""),
    name: String(campaign.display_name ?? ""),
    status: String(campaign.status ?? ""),
    code: String(code.code ?? ""),
    channel: String(campaign.campaign_type || metadata.channel || ""),
    landing_page: String(metadata.landing_page || metadata.landing_page_path || ""),
    landing_variant: String(campaign.landing_variant || code.landing_variant || ""),
    signup_url: String(campaign.signup_url || ""),
    created_at: String(campaign.created_at ?? ""),
    updated_at: String(campaign.updated_at ?? ""),
    metadata
  };
}

function rawAttributionRow(entry: JsonObject) {
  const metadata = asObject(entry.metadata);
  return {
    attribution_id: String(entry.id ?? ""),
    campaign_id: String(entry.partner_id ?? ""),
    campaign_name: String(entry.campaign_name ?? ""),
    code_id: String(entry.code_id ?? ""),
    code: String(entry.referral_code ?? ""),
    status: String(entry.status ?? ""),
    source: String(entry.source ?? ""),
    org_id: String(entry.referred_org_id ?? ""),
    email: String(entry.referred_email ?? ""),
    created_at: String(entry.created_at ?? ""),
    updated_at: String(entry.updated_at ?? ""),
    signup_completed_at: String(entry.signup_completed_at ?? ""),
    landing_page: String(metadata.landing_page || metadata.landing_page_path || metadata.page_path || entry.landing_variant || ""),
    utm_source: String(metadata.utm_source || ""),
    utm_medium: String(metadata.utm_medium || ""),
    utm_campaign: String(metadata.utm_campaign || ""),
    client_ip: String(metadata.landing_client_ip || metadata.client_ip || ""),
    signup_client_ip: String(metadata.signup_client_ip || ""),
    country: String(metadata.cf_ipcountry || metadata.x_vercel_ip_country || metadata.x_appengine_country || ""),
    city: String(metadata.x_vercel_ip_city || metadata.cf_city || metadata.x_appengine_city || ""),
    browser: browserFamily(String(metadata.browser_user_agent || metadata.user_agent || "")),
    device: deviceClass(metadata),
    timezone: String(metadata.timezone || metadata.cf_timezone || ""),
    acquisition_bonus_token: String(metadata.acquisition_bonus_token || ""),
    acquisition_bonus_set_id: String(metadata.acquisition_bonus_set_id || ""),
    acquisition_bonus_label: String(metadata.acquisition_bonus_label || ""),
    metadata
  };
}

function rawSignupRow(entry: JsonObject, spendByOrg: Map<unknown, JsonObject>) {
  const raw = rawAttributionRow(entry);
  const spend = asObject(spendByOrg.get(String(entry.referred_org_id ?? "")));
  return {
    ...raw,
    spend: Number(spend.spend ?? 0),
    orders: Number(spend.orders ?? 0)
  };
}

function rawEventRow(entry: JsonObject) {
  const metadata = asObject(entry.metadata);
  return {
    event_id: String(entry.id ?? ""),
    campaign_id: String(entry.partner_id ?? ""),
    campaign_name: String(entry.campaign_name ?? ""),
    code_id: String(entry.code_id ?? ""),
    code: String(entry.code ?? ""),
    event_type: String(entry.event_type ?? ""),
    event_count: Number(entry.event_count ?? 1),
    first_seen_at: String(entry.first_seen_at ?? ""),
    last_seen_at: String(entry.last_seen_at ?? ""),
    created_at: String(entry.created_at ?? ""),
    updated_at: String(entry.updated_at ?? ""),
    metadata
  };
}

export function getReferralPartner(partnerId: string) {
  const id = String(partnerId || "").trim();
  const partner = id ? row("SELECT * FROM referral_partners WHERE id = :id LIMIT 1", { id }) : null;
  if (!partner) throw notFound("referral_partner_not_found", "Referral partner was not found.");
  const primaryCode = primaryCodeForPartner(id);
  return {
    ok: true,
    success: true,
    partner,
    primary_code: primaryCode,
    signup_url: primaryCode ? referralSignupUrl(primaryCode.code) : ""
  };
}

export async function saveReferralPartner(input: JsonObject) {
  const now = nowIso();
  const id = String(input.id ?? "").trim() || generateId("refp");
  const displayName = String(input.display_name ?? input.name ?? "").trim();
  if (!displayName) throw badRequest("display_name_required", "Display name is required.");
  const existing = row("SELECT * FROM referral_partners WHERE id = :id LIMIT 1", { id });
  const partner = {
    id,
    type: normalizePartnerType(input.type),
    status: normalizePartnerStatus(input.status),
    display_name: displayName,
    company_name: String(input.company_name ?? "").trim(),
    contact_name: String(input.contact_name ?? "").trim(),
    contact_email: String(input.contact_email ?? "").trim().toLowerCase(),
    contact_phone: String(input.contact_phone ?? "").trim(),
        linked_user_email: String(input.linked_user_email ?? "").trim().toLowerCase(),
        linked_org_id: String(input.linked_org_id ?? "").trim(),
        logo_url: String(input.logo_url ?? "").trim(),
    logo_path: String(input.logo_path ?? "").trim(),
    notes: String(input.notes ?? "").trim(),
    metadata_json: JSON.stringify(asObject(input.metadata)),
    created_at: String(existing?.created_at ?? now),
    updated_at: now
  };
  withReferralDb((db) => {
    db.prepare(`
      INSERT INTO referral_partners (
        id, type, status, display_name, company_name, contact_name, contact_email, contact_phone,
        linked_user_email, linked_org_id, logo_url, logo_path, notes, metadata_json, created_at, updated_at
      ) VALUES (
        :id, :type, :status, :display_name, :company_name, :contact_name, :contact_email, :contact_phone,
        :linked_user_email, :linked_org_id, :logo_url, :logo_path, :notes, :metadata_json, :created_at, :updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        status = excluded.status,
        display_name = excluded.display_name,
        company_name = excluded.company_name,
        contact_name = excluded.contact_name,
        contact_email = excluded.contact_email,
        contact_phone = excluded.contact_phone,
        linked_user_email = excluded.linked_user_email,
        linked_org_id = excluded.linked_org_id,
        logo_url = excluded.logo_url,
        logo_path = excluded.logo_path,
        notes = excluded.notes,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(partner as any);
  });
  const primaryCode = ensurePrimaryCode(id, displayName, String(input.new_org_offer_id ?? ""), String(input.referrer_reward_policy_id ?? ""));
  return {
    ok: true,
    success: true,
    saved: true,
    partner: hydratePartner(partner),
    primary_code: primaryCode,
    signup_url: referralSignupUrl(primaryCode.code)
  };
}

export async function saveReferralPartnerLogo(partnerId: string, file: { filename: string; mimetype: string; toBuffer: () => Promise<Buffer> }) {
  const detail = getReferralPartner(partnerId);
  const partner = asObject(detail.partner);
  const originalName = path.basename(file.filename || "logo");
  const ext = logoExtension(originalName, file.mimetype);
  const logoDir = path.join(crmStorageRoot(), "referral-logos");
  await mkdir(logoDir, { recursive: true });
  const fileName = `${String(partner.id)}-${Date.now()}${ext}`;
  const absolutePath = path.join(logoDir, fileName);
  await writeFile(absolutePath, await file.toBuffer());
  const logoUrl = `/v1/internal/crm/referrals/logos/${encodeURIComponent(fileName)}`;
  return saveReferralPartner({
    ...partner,
    logo_url: logoUrl,
    logo_path: absolutePath
  });
}

export async function searchReferralOrganizations(query: string, limit: number) {
  const q = String(query || "").trim().toLowerCase();
  const referralByOrg = new Map(rows(`
    SELECT ra.referred_org_id, ra.referral_code, rp.display_name AS referral_partner_name
    FROM referral_attributions ra
    LEFT JOIN referral_partners rp ON rp.id = ra.partner_id
    WHERE COALESCE(ra.referred_org_id, '') <> ''
    ORDER BY ra.updated_at DESC
  `).map((entry) => [String(entry.referred_org_id ?? ""), entry]));
  const organizations = await listOrganizations();
  return organizations
    .filter((organization) => {
      if (!q) return true;
      return [
        organization.id,
        organization.name,
        organization.slug,
        organization.owner_email,
        organization.billing_email,
        asObject(organization.metadata).phone
      ].some((value) => String(value ?? "").toLowerCase().includes(q));
    })
    .slice(0, Math.max(1, Math.min(250, limit || 80)))
    .map((organization) => {
      const referral = referralByOrg.get(String(organization.id ?? ""));
      return {
        id: organization.id,
        name: organization.name || organization.slug || organization.id,
        email: organization.owner_email || organization.billing_email || "",
        owner_email: organization.owner_email || organization.billing_email || "",
        phone: asObject(organization.metadata).phone || "",
        created_at: organization.created_at || "",
        disabled: false,
        has_referral: Boolean(referral),
        referral_code: referral?.referral_code || "",
        referral_partner_name: referral?.referral_partner_name || ""
      };
    });
}

export async function attachReferralOrganization(input: JsonObject) {
  const partnerId = String(input.partner_id ?? input.partnerId ?? "").trim();
  const orgId = String(input.org_id ?? input.organization_id ?? input.orgId ?? "").trim();
  if (!partnerId || !orgId) throw badRequest("missing_referral_attach_target", "Partner and organization are required.");
  const partnerDetail = getReferralPartner(partnerId);
  const partner = asObject(partnerDetail.partner);
  const code = asObject(partnerDetail.primary_code);
  if (!code.id) throw badRequest("referral_code_missing", "Referral partner does not have a primary code.");
  const now = nowIso();
  const existing = row("SELECT * FROM referral_attributions WHERE referred_org_id = :org_id LIMIT 1", { org_id: orgId });
  const attributionId = String(existing?.id ?? generateId("refa"));
  withReferralDb((db) => {
    db.prepare(`
      INSERT INTO referral_attributions (
        id, partner_id, code_id, referral_code, referred_org_id, referred_email, status, source, note,
        metadata_json, signup_completed_at, created_at, updated_at
      ) VALUES (
        :id, :partner_id, :code_id, :referral_code, :referred_org_id, :referred_email, :status, :source, :note,
        :metadata_json, :signup_completed_at, :created_at, :updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        partner_id = excluded.partner_id,
        code_id = excluded.code_id,
        referral_code = excluded.referral_code,
        note = excluded.note,
        updated_at = excluded.updated_at
    `).run({
      id: attributionId,
      partner_id: partnerId,
      code_id: String(code.id),
      referral_code: String(code.code ?? ""),
      referred_org_id: orgId,
      referred_email: String(input.email ?? ""),
      status: "signup_completed",
      source: "manual_attach",
      note: String(input.note ?? ""),
      metadata_json: JSON.stringify({ manual_attach: true }),
      signup_completed_at: String(existing?.signup_completed_at ?? now),
      created_at: String(existing?.created_at ?? now),
      updated_at: now
    } as any);
  });
  await patchOrganization(orgId, {
    referral_partner_id: partnerId,
    referral_code: String(code.code ?? ""),
    referral_attribution_id: attributionId,
    referral_partner_name: String(partner.display_name ?? "")
  }).catch(() => null);
  return {
    ok: true,
    success: true,
    attached: true,
    attribution_id: attributionId,
    partner_id: partnerId,
    org_id: orgId
  };
}

export async function completeAcquisitionSignup(input: JsonObject) {
  const orgId = String(input.org_id ?? input.organization_id ?? input.orgId ?? "").trim();
  const email = String(input.email ?? input.referred_email ?? "").trim().toLowerCase();
  const explicitCodeValue = String(input.acquisition_code ?? input.cid ?? input.campaign_code ?? input.referral_code ?? input.code ?? "").trim();
  const fallbackCodeValue = campaignCodeFallback(input.campaign);
  const codeValue = explicitCodeValue || fallbackCodeValue;
  let attributionId = String(input.acquisition_attribution_id ?? input.referral_attribution_id ?? input.attribution_id ?? input.attributionId ?? "").trim();
  const hasLandingAttribution = landingPathCandidates(input).length > 0 || !!normalizedLandingVariant(input.landing_variant);
  if (!orgId || !email || (!codeValue && !attributionId && !hasLandingAttribution)) return { ok: false, success: false, error: "missing_acquisition_inputs" };

  const existing = row("SELECT * FROM referral_attributions WHERE referred_org_id = :org_id LIMIT 1", { org_id: orgId });
  if (existing) return { ok: true, success: true, already_linked: true, attribution_id: String(existing.id ?? ""), acquisition_attribution_id: String(existing.id ?? ""), offer_id: "" };

  let code = explicitCodeValue ? referralCodeByCode(explicitCodeValue, true) : null;
  if (!code && attributionId) {
    const attribution = row("SELECT * FROM referral_attributions WHERE id = :id LIMIT 1", { id: attributionId });
    if (attribution) code = row("SELECT * FROM referral_codes WHERE id = :id LIMIT 1", { id: String(attribution.code_id ?? "") });
  }
  if (!code) code = acquisitionLinkByLanding(input);
  if (!code && fallbackCodeValue) code = referralCodeByCode(fallbackCodeValue, true);
  if (!code && codeValue) {
    code = ensureAcquisitionLink({
      campaign: codeValue,
      campaign_type: input.campaign_type || input.source || input.utm_source || "marketing",
      landing_variant: input.landing_variant,
      metadata: attributionMetadata(input)
    });
  }
  if (!code) return { ok: false, success: false, error: "invalid_acquisition_code" };

  const partner = row("SELECT * FROM referral_partners WHERE id = :id LIMIT 1", { id: String(code.partner_id ?? "") });
  if (!partner) return { ok: false, success: false, error: "invalid_acquisition_campaign" };

  let attribution = attributionId
    ? row("SELECT * FROM referral_attributions WHERE id = :id AND code_id = :code_id AND partner_id = :partner_id LIMIT 1", {
      id: attributionId,
      code_id: String(code.id ?? ""),
      partner_id: String(partner.id ?? "")
    })
    : null;
  if (!attribution) {
    attributionId = createViewedAttribution(partner, code, "signup_completion", attributionMetadata(input));
    attribution = row("SELECT * FROM referral_attributions WHERE id = :id LIMIT 1", { id: attributionId });
  }
  if (!attribution) return { ok: false, success: false, error: "attribution_create_failed" };

  const now = nowIso();
  const offerId = String(code.new_org_offer_id ?? "").trim();
  const codeMetadata = asObject(code.metadata);
  const previousAttributionMeta: JsonObject = {
    ...asObject(attribution.metadata),
    ...asObject(attribution.metadata_json)
  };
  const signupAttributionMeta: JsonObject = attributionMetadata(input);
  const attributionMeta: JsonObject = {
    ...previousAttributionMeta,
    landing_client_ip: String(previousAttributionMeta.landing_client_ip || previousAttributionMeta.client_ip || ""),
    landing_user_agent: String(previousAttributionMeta.landing_user_agent || previousAttributionMeta.user_agent || ""),
    landing_country: String(previousAttributionMeta.landing_country || previousAttributionMeta.cf_ipcountry || previousAttributionMeta.x_vercel_ip_country || previousAttributionMeta.x_appengine_country || ""),
    landing_city: String(previousAttributionMeta.landing_city || previousAttributionMeta.x_vercel_ip_city || previousAttributionMeta.cf_city || previousAttributionMeta.x_appengine_city || ""),
    ...signupAttributionMeta,
    signup_client_ip: String(signupAttributionMeta.client_ip || ""),
    signup_user_agent: String(signupAttributionMeta.user_agent || ""),
    signup_country: String(signupAttributionMeta.cf_ipcountry || signupAttributionMeta.x_vercel_ip_country || signupAttributionMeta.x_appengine_country || ""),
    signup_city: String(signupAttributionMeta.x_vercel_ip_city || signupAttributionMeta.cf_city || signupAttributionMeta.x_appengine_city || "")
  };
  const bonusToken = String(firstNonBlank(
    attributionMeta.acquisition_bonus_token,
    attributionMeta[BONUS_QUERY_KEY],
    input.acquisition_bonus_token,
    input[BONUS_QUERY_KEY],
    input.xid
  ) ?? "").trim();
  const assignedBonusSet = bonusToken
    ? findBonusSetByToken(partner, code, bonusToken)
    : assignBonusOfferSet(partner, code, input);
  if (assignedBonusSet) {
    const assignedBonusToken = bonusToken || String(assignedBonusSet.token ?? "");
    attributionMeta.acquisition_bonus_offer_id = ACQUISITION_BONUS_OFFER_ID;
    attributionMeta.acquisition_bonus_token = assignedBonusToken;
    attributionMeta.acquisition_bonus_set_id = String(assignedBonusSet.id ?? "");
    attributionMeta.acquisition_bonus_label = String(assignedBonusSet.label ?? "");
    attributionMeta.acquisition_bonus_tiers = JSON.stringify(assignedBonusSet.tiers ?? []);
  }
  const sourceType = String(codeMetadata.source_type || attributionMeta.source_type || (isReferralAcquisition(partner, code) ? "referral" : "marketing"));
  const snapshot = {
    campaign: {
      id: String(partner.id ?? ""),
      type: String(partner.type ?? ""),
      source_type: sourceType,
      display_name: String(partner.display_name ?? ""),
      name: String(partner.display_name ?? "")
    },
    link: {
      id: String(code.id ?? ""),
      code: String(code.code ?? ""),
      campaign_type: String(code.campaign_type ?? ""),
      landing_variant: String(code.landing_variant ?? ""),
      new_org_offer_id: offerId,
      referrer_reward_policy_id: String(code.referrer_reward_policy_id ?? ""),
      metadata: codeMetadata
    },
    signup: {
      organization_id: orgId,
      email,
      name: String(input.name ?? ""),
      company: String(input.company ?? "")
    },
    attribution: attributionMeta
  };
  withReferralDb((db) => db.prepare(`
    UPDATE referral_attributions
    SET referred_org_id = :referred_org_id,
        referred_email = :referred_email,
        status = 'signup_completed',
        signup_completed_at = :signup_completed_at,
        metadata_json = :metadata_json,
        updated_at = :updated_at
    WHERE id = :id
  `).run({
    id: attributionId,
    referred_org_id: orgId,
    referred_email: email,
    signup_completed_at: now,
    metadata_json: JSON.stringify({ ...attributionMeta, signup: snapshot }),
    updated_at: now
  } as any));

  const orgPatch: JsonObject = {
    acquisition_source_type: sourceType,
    acquisition_campaign_id: String(partner.id ?? ""),
    acquisition_campaign_name: String(partner.display_name ?? ""),
    acquisition_code: String(code.code ?? ""),
    acquisition_attribution_id: attributionId,
    acquisition_landing_variant: String(code.landing_variant || attributionMeta.landing_variant || ""),
    acquisition_metadata: {
      code: String(code.code ?? ""),
      campaign_type: String(code.campaign_type ?? ""),
      source_type: sourceType,
      ...attributionMeta
    }
  };
  if (assignedBonusSet) {
    orgPatch.acquisition_bonus_offer = bonusSetPublicView(assignedBonusSet, partner);
  }
  if (isReferralAcquisition(partner, code)) {
    Object.assign(orgPatch, {
    referral_partner_id: String(partner.id ?? ""),
    referral_code: String(code.code ?? ""),
    referral_attribution_id: attributionId,
    referral_partner_name: String(partner.display_name ?? ""),
    referred_by_org_id: String(partner.linked_org_id ?? ""),
    referred_by_user_email: String(partner.linked_user_email ?? "")
    });
  }
  await patchOrganization(orgId, orgPatch).catch(() => null);

  return {
    ok: true,
    success: true,
    attribution_id: attributionId,
    acquisition_attribution_id: attributionId,
    acquisition_source_type: sourceType,
    offer_id: offerId,
    partner: hydratePartner(partner),
    campaign: hydratePartner(partner),
    code
  };
}

export async function completeReferralSignup(input: JsonObject) {
  const result = await completeAcquisitionSignup({ ...input, source_type: "referral" });
  return {
    ...result,
    referral_attribution_id: result.acquisition_attribution_id || result.attribution_id,
    referral_partner_id: asObject(result.partner).id || "",
    referral_code: asObject(result.code).code || input.referral_code || ""
  };
}

export function publicAcquisitionLookup(input: JsonObject, baseUrl = "") {
  const explicitCodeValue = String(input.acquisition_code ?? input.cid ?? input.campaign_code ?? input.referral_code ?? input.ref ?? input.code ?? "").trim();
  const fallbackCodeValue = campaignCodeFallback(input.campaign);
  const codeValue = explicitCodeValue || fallbackCodeValue;
  let code = explicitCodeValue ? referralCodeByCode(explicitCodeValue, true) : null;
  if (!code) code = acquisitionLinkByLanding(input);
  if (!code && fallbackCodeValue) code = referralCodeByCode(fallbackCodeValue, true);
  if (!code && codeValue) {
    code = ensureAcquisitionLink({
      campaign: codeValue,
      campaign_type: input.campaign_type || input.source || input.utm_source || "marketing",
      landing_variant: input.landing_variant,
      metadata: attributionMetadata(input)
    });
  }
  if (!code) return { success: false, ok: false, error: "Acquisition link not found." };
  const partner = row("SELECT * FROM referral_partners WHERE id = :id LIMIT 1", { id: String(code.partner_id ?? "") });
  if (!partner || normalizePartnerStatus(partner.status) !== "active") {
    return { success: false, ok: false, error: "Acquisition campaign is not active." };
  }
  const hydratedPartner = hydratePartner(partner);
  const now = nowIso();
  withReferralDb((db) => {
    db.prepare("UPDATE referral_codes SET landing_views = COALESCE(landing_views, 0) + 1, last_viewed_at = :now, updated_at = :now WHERE id = :id")
      .run({ now, id: String(code.id ?? "") } as any);
  });
  const bonusOffer = assignBonusOfferSet(partner, code, input);
  const attributionId = createViewedAttribution(partner, code, "public_acquisition_lookup", {
    ...attributionMetadata(input),
    ...(bonusOffer ? {
      acquisition_bonus_offer_id: ACQUISITION_BONUS_OFFER_ID,
      acquisition_bonus_token: bonusOffer.token,
      acquisition_bonus_set_id: bonusOffer.id,
      acquisition_bonus_label: bonusOffer.label,
      acquisition_bonus_tiers: JSON.stringify(bonusOffer.tiers)
    } : {})
  });
  const copy = isReferralAcquisition(partner, code) ? referralInvitationCopy(hydratedPartner, code) : { headline: "", subheadline: "", offer: null };
  return {
    success: true,
    ok: true,
    campaign: hydratedPartner,
    acquisition_campaign: hydratedPartner,
    link: code,
    acquisition_link: code,
    acquisition_attribution_id: attributionId,
    attribution_id: attributionId,
    bonus_query_key: BONUS_QUERY_KEY,
    bonus_offer: bonusOffer,
    source_type: isReferralAcquisition(partner, code) ? "referral" : "marketing",
    partner: hydratedPartner,
    code,
    headline: copy.headline,
    subheadline: copy.subheadline,
    offer: copy.offer,
    signup_url: acquisitionSignupUrl(code.code, baseUrl)
  };
}

export async function acquisitionBonusOfferForOrganization(orgId: string) {
  const assignment = await acquisitionBonusAssignmentForOrg(orgId);
  if (!assignment) return {
    success: true,
    ok: true,
    offer_enabled: false,
    offer_id: "",
    bonus_query_key: BONUS_QUERY_KEY,
    offer: null,
    tiers: []
  };
  return {
    success: true,
    ok: true,
    offer_enabled: true,
    show_banner: false,
    offer_id: ACQUISITION_BONUS_OFFER_ID,
    bonus_query_key: BONUS_QUERY_KEY,
    campaign_id: assignment.campaign_id,
    campaign_name: assignment.campaign_name,
    token: assignment.token,
    offer: assignment,
    tiers: assignment.tiers
  };
}

export async function acquisitionBonusOfferForCampaignToken(orgId: string, campaignValue: unknown, tokenValue: unknown, persistToOrganization = false, viewMetadata: JsonObject = {}) {
  const campaign = String(campaignValue ?? "").trim();
  const token = String(tokenValue ?? "").trim();
  if (!campaign || !token) return { success: false, ok: false, error: "Campaign and bonus token are required." };
  const code = referralCodeByCode(campaign, true) || primaryCodeForPartner(campaign);
  const partnerId = String(code?.partner_id ?? campaign);
  const partner = row("SELECT * FROM referral_partners WHERE id = :id AND type = 'acquisition_campaign' LIMIT 1", { id: partnerId });
  if (!partner || normalizePartnerStatus(partner.status) !== "active") {
    return { success: false, ok: false, error: "Acquisition campaign is not active." };
  }
  const primaryCode = code || primaryCodeForPartner(String(partner.id ?? "")) || {};
  const set = findBonusSetByToken(partner, primaryCode, token);
  if (!set) return { success: false, ok: false, error: "Bonus offer token not found for this campaign." };
  const offer = bonusSetPublicView(set, partner);
  let attributionId = "";
  if (persistToOrganization) {
    attributionId = createViewedAttribution(partner, primaryCode, "portal_bonus_test", {
      ...attributionMetadata(viewMetadata),
      acquisition_bonus_offer_id: ACQUISITION_BONUS_OFFER_ID,
      acquisition_bonus_token: offer.token,
      acquisition_bonus_set_id: offer.id,
      acquisition_bonus_label: offer.label,
      acquisition_bonus_tiers: JSON.stringify(offer.tiers ?? []),
      test_override: "1"
    });
  }
  if (persistToOrganization && orgId) {
    await patchOrganization(orgId, {
      acquisition_source_type: "marketing",
      acquisition_campaign_id: String(partner.id ?? ""),
      acquisition_campaign_name: String(partner.display_name ?? ""),
      acquisition_code: String(primaryCode.code ?? campaign),
      acquisition_attribution_id: attributionId,
      acquisition_landing_variant: String(primaryCode.landing_variant ?? ""),
      acquisition_bonus_offer: offer,
      acquisition_metadata: {
        code: String(primaryCode.code ?? campaign),
        acquisition_attribution_id: attributionId,
        campaign_type: String(primaryCode.campaign_type ?? ""),
        source_type: "marketing",
        acquisition_bonus_offer_id: ACQUISITION_BONUS_OFFER_ID,
        acquisition_bonus_token: offer.token,
        acquisition_bonus_set_id: offer.id,
        acquisition_bonus_label: offer.label,
        acquisition_bonus_tiers: JSON.stringify(offer.tiers ?? [])
      }
    }).catch(() => null);
  }
  return {
    success: true,
    ok: true,
    offer_enabled: true,
    show_banner: false,
    offer_id: ACQUISITION_BONUS_OFFER_ID,
    bonus_query_key: BONUS_QUERY_KEY,
    campaign_id: offer.campaign_id,
    campaign_name: offer.campaign_name,
    token: offer.token,
    offer,
    tiers: offer.tiers
  };
}

export async function acquisitionBonusQuoteForOrganization(orgId: string, amount: number, tokenValue = "") {
  const assignment = await acquisitionBonusAssignmentForOrg(orgId);
  const amountValue = Math.max(1, Math.round(Number(amount || 0)));
  if (!assignment) return { valid: false, reason: "no_acquisition_bonus_offer", tier_id: "", bonus_dollars: 0, total_account_value: amountValue };
  const requestedToken = String(tokenValue || "").trim();
  if (requestedToken && requestedToken !== assignment.token) {
    return { valid: false, reason: "bonus_offer_token_mismatch", tier_id: "", bonus_dollars: 0, total_account_value: amountValue };
  }
  const tiers = assignment.tiers
    .filter((tier) => Number(tier.customer_pays ?? tier.threshold ?? 0) <= amountValue)
    .sort((a, b) => Number(b.customer_pays ?? b.threshold ?? 0) - Number(a.customer_pays ?? a.threshold ?? 0));
  const tier = tiers[0];
  if (!tier) return { valid: false, reason: "below_bonus_threshold", tier_id: "", bonus_dollars: 0, total_account_value: amountValue };
  const matchPercent = Math.max(0, Number(tier.match_percent ?? 0));
  const bonusDollars = Math.round((amountValue * matchPercent) / 100);
  return {
    valid: true,
    reason: "",
    offer_id: ACQUISITION_BONUS_OFFER_ID,
    token: assignment.token,
    set_id: assignment.id,
    label: assignment.label,
    tier_id: String(tier.id ?? ""),
    threshold: Number(tier.customer_pays ?? tier.threshold ?? 0),
    match_percent: matchPercent,
    bonus_dollars: bonusDollars,
    total_account_value: amountValue + bonusDollars
  };
}

export function publicReferralLookup(codeValue: string, baseUrl = "") {
  const result = publicAcquisitionLookup({ referral_code: codeValue, source_type: "referral" }, baseUrl);
  if (!result.success) return { ...result, error: "Referral link not found." };
  return {
    ...result,
    success: true,
    ok: true,
    referral_attribution_id: result.acquisition_attribution_id,
    signup_url: referralSignupUrl(asObject(result.code).code, baseUrl)
  };
}

export async function customerReferralStatus(input: JsonObject) {
  const email = String(input.email ?? input.actor_email ?? "").trim().toLowerCase();
  const orgId = String(input.org_id ?? input.actor_org_id ?? "").trim();
  const offerVariant = normalizeCustomerReferralOfferVariant(input.offer_variant);
  if (!email) return { success: false, ok: false, error: "missing_email" };
  const eligibility = await customerReferralEligibility(orgId);
  const partner = ensureCustomerReferralPartner({
    email,
    orgId,
    name: String(input.name ?? input.actor_name ?? "").trim(),
    company: String(input.company ?? "").trim()
  });
  if (!partner) return { success: false, ok: false, error: "referral_partner_unavailable" };
  const code = ensurePrimaryCode(
    String(partner.id),
    String(partner.display_name || email),
    "",
    customerReferralRewardPolicyId(offerVariant),
    { campaign_type: "customer_referral", landing_variant: "customer_invite", offer_variant: offerVariant }
  );
  if (truthy(input.track_impression) && eligibility.show) {
    trackReferralEvent({
      partner_id: String(partner.id),
      code_id: String(code.id ?? ""),
      code: String(code.code ?? ""),
      email,
      org_id: orgId,
      event_type: "offer_impression",
      metadata: { source: "customer_portal", offer_variant: offerVariant }
    });
  }
  return {
    success: true,
    ok: true,
    show_banner: eligibility.show,
    reason: eligibility.reason,
    eligible_at: eligibility.eligible_at ?? null,
    seconds_until_eligible: eligibility.seconds_until_eligible ?? 0,
    bonus_first_shown_at: eligibility.bonus_first_shown_at ?? null,
    partner: { id: String(partner.id), display_name: String(partner.display_name ?? "") },
    code: { id: String(code.id ?? ""), code: String(code.code ?? "") },
    offer_variant: offerVariant,
    reward_policy_id: customerReferralRewardPolicyId(offerVariant),
    signup_url: referralSignupUrl(code.code, String(input.base_url ?? "")),
    stats: {
      ...partnerStats(String(partner.id)),
      landing_views: Number(code.landing_views ?? 0)
    }
  };
}

export function customerReferralEvent(input: JsonObject) {
  const email = String(input.email ?? input.actor_email ?? "").trim().toLowerCase();
  const orgId = String(input.org_id ?? input.actor_org_id ?? "").trim();
  const offerVariant = normalizeCustomerReferralOfferVariant(input.offer_variant);
  if (!email) return { success: false, ok: false, error: "missing_email" };
  const partner = ensureCustomerReferralPartner({
    email,
    orgId,
    name: String(input.name ?? input.actor_name ?? "").trim(),
    company: String(input.company ?? "").trim()
  });
  if (!partner) return { success: false, ok: false, error: "referral_partner_unavailable" };
  const code = primaryCodeForPartner(String(partner.id))
    ?? ensurePrimaryCode(String(partner.id), String(partner.display_name || email), "", customerReferralRewardPolicyId(offerVariant), { campaign_type: "customer_referral", landing_variant: "customer_invite", offer_variant: offerVariant });
  return trackReferralEvent({
    partner_id: String(partner.id),
    code_id: String(code.id ?? ""),
    code: String(code.code ?? ""),
    email,
    org_id: orgId,
    event_type: String(input.event_type ?? ""),
    metadata: { source: "customer_portal", offer_variant: offerVariant }
  });
}

function normalizeCustomerReferralOfferVariant(value: unknown) {
  const variant = String(value ?? "").trim().toLowerCase();
  return ["gift_card_50", "credits_50"].includes(variant) ? variant : "gift_card_50";
}

function customerReferralRewardPolicyId(variant: string) {
  return variant === "credits_50" ? "customer_referral_credits_50_v1" : "customer_referral_gift_card_50_v1";
}

export function referralRewardReport() {
  return rows(`
    SELECT
      ra.*,
      rp.display_name AS partner_name,
      rp.linked_user_email AS referrer_email,
      rc.code AS referral_code,
      rc.referrer_reward_policy_id AS policy_id,
      rrl.id AS reward_id,
      rrl.reward_type AS reward_type,
      rrl.amount AS reward_amount,
      rrl.status AS reward_status,
      rrl.created_at AS reward_created_at,
      rrl.applied_at AS reward_applied_at,
      rrl.metadata_json AS reward_metadata_json
    FROM referral_attributions ra
    LEFT JOIN referral_partners rp ON rp.id = ra.partner_id
    LEFT JOIN referral_codes rc ON rc.id = ra.code_id
    LEFT JOIN referral_reward_ledger rrl ON rrl.attribution_id = ra.id
    ORDER BY ra.updated_at DESC
    LIMIT 500
  `).map((entry) => {
    const rewardId = String(entry.reward_id ?? "");
    return {
      ...entry,
      referred_org_name: entry.referred_org_id || "",
      policy_label: entry.policy_id || "",
      threshold_paid_revenue: 0,
      qualified_paid_revenue: 0,
      progress_percent: rewardId ? 100 : 0,
      reward: rewardId ? {
        id: rewardId,
        reward_type: entry.reward_type,
        amount: Number(entry.reward_amount ?? 0),
        status: entry.reward_status,
        created_at: entry.reward_created_at,
        applied_at: entry.reward_applied_at,
        metadata: entry.reward_metadata
      } : null
    };
  });
}

export function updateReferralRewardStatus(rewardId: string, statusInput: string) {
  const id = String(rewardId || "").trim();
  const status = normalizeRewardStatus(statusInput);
  if (!id) throw badRequest("reward_id_required", "Reward id is required.");
  const existing = row("SELECT * FROM referral_reward_ledger WHERE id = :id LIMIT 1", { id });
  if (!existing) throw notFound("referral_reward_not_found", "Referral reward was not found.");
  const now = nowIso();
  withReferralDb((db) => db.prepare(`
    UPDATE referral_reward_ledger
    SET status = :status, updated_at = :updated_at, applied_at = CASE WHEN :status = 'sent' THEN :applied_at ELSE applied_at END
    WHERE id = :id
  `).run({ id, status, updated_at: now, applied_at: now } as any));
  return { ok: true, success: true, updated: true, reward_id: id, status };
}

function normalizeBonusOfferSets(value: unknown, existingState: JsonObject = {}, existingSets: JsonObject = {}) {
  const rawSets = Array.isArray(value)
    ? value
    : Array.isArray(asObject(value).sets) ? asObject(value).sets as unknown[] : [];
  const existingById = new Map<string, JsonObject>();
  Object.values(existingSets).forEach((entry) => {
    const set = asObject(entry);
    const id = String(set.id ?? "").trim();
    if (id) existingById.set(id, set);
  });
  const normalized: JsonObject = {};
  rawSets.forEach((rawSet, index) => {
    const set = asObject(rawSet);
    const id = slugify(String(set.id ?? set.name ?? set.label ?? `set-${index + 1}`)) || `set-${index + 1}`;
    const prior = existingById.get(id) || {};
    const tiersInput = Array.isArray(set.tiers) ? set.tiers : Array.isArray(set.options) ? set.options : [];
    const tiers = normalizeBonusTierSet(tiersInput);
    const token = String(set.token ?? prior.token ?? "").trim() || shortOpaqueToken();
    normalized[id] = {
      id,
      token,
      label: String(set.label ?? set.name ?? prior.label ?? `Offer Set ${index + 1}`).trim() || `Offer Set ${index + 1}`,
      status: normalizeBonusSetStatus(set.status ?? prior.status ?? "active"),
      tiers,
      assigned_count: Number(asObject(existingState)[token] ?? set.assigned_count ?? prior.assigned_count ?? 0),
      created_at: String(prior.created_at ?? new Date().toISOString()),
      updated_at: new Date().toISOString()
    };
  });
  return normalized;
}

function normalizeBonusTierSet(value: unknown) {
  const provided = (Array.isArray(value) ? value : [])
    .map((rawTier, tierIndex) => normalizeBonusTier(rawTier, tierIndex))
    .filter((tier) => Number(tier.customer_pays ?? 0) > 0)
    .sort((a, b) => Number(a.customer_pays ?? 0) - Number(b.customer_pays ?? 0))
    .slice(0, 3);
  return DEFAULT_ACQUISITION_BONUS_TIERS.map((fallback, index) => {
    const tier = provided[index] || normalizeBonusTier(fallback, index);
    return normalizeBonusTier({ ...tier, id: `tier_${index + 1}` }, index);
  });
}

function normalizeBonusTier(value: unknown, index: number) {
  const tier = asObject(value);
  const customerPays = Math.max(0, Math.round(Number(tier.customer_pays ?? tier.threshold ?? tier.amount ?? tier.minimum ?? 0)));
  const matchPercent = Math.max(0, Math.min(500, Number(tier.match_percent ?? tier.match ?? tier.percent ?? 0)));
  const bonusDollars = Math.round((customerPays * matchPercent) / 100);
  return {
    id: String(tier.id ?? `tier_${index + 1}`),
    customer_pays: customerPays,
    threshold: customerPays,
    match_percent: matchPercent,
    bonus_dollars: bonusDollars,
    total_account_value: customerPays + bonusDollars
  };
}

function normalizeBonusSetStatus(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  return ["active", "inactive", "archived"].includes(raw) ? raw : "active";
}

function mergeBonusOfferState(existingState: JsonObject, sets: JsonObject) {
  const next: JsonObject = {};
  Object.values(sets).forEach((entry) => {
    const set = asObject(entry);
    const token = String(set.token ?? "").trim();
    if (!token) return;
    next[token] = Number(existingState[token] ?? set.assigned_count ?? 0);
  });
  return next;
}

function shortOpaqueToken() {
  return Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(2, 10)
    + Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(2, 6);
}

function campaignBonusSets(partner: JsonObject, code: JsonObject = {}) {
  const metadata = { ...asObject(partner.metadata), ...asObject(code.metadata) };
  const sets = asObject(metadata.bonus_offer_sets);
  return Object.values(sets)
    .map((entry) => asObject(entry))
    .filter((set) => String(set.token ?? "").trim() && normalizeBonusSetStatus(set.status) === "active" && Array.isArray(set.tiers) && (set.tiers as unknown[]).length > 0);
}

function findBonusSetByToken(partner: JsonObject, code: JsonObject, tokenValue: unknown) {
  const token = String(tokenValue ?? "").trim();
  if (!token) return null;
  return campaignBonusSets(partner, code).find((set) => String(set.token ?? "") === token) || null;
}

function assignBonusOfferSet(partner: JsonObject, code: JsonObject, input: JsonObject) {
  const requestedToken = firstNonBlank(input[BONUS_QUERY_KEY], input.xid, input.acquisition_bonus_token, input.bonus_token);
  const requested = findBonusSetByToken(partner, code, requestedToken);
  const sets = campaignBonusSets(partner, code);
  if (!sets.length) return null;
  const sticky = requested ? null : stickyBonusSetForVisitor(partner, code, input, sets);
  const metadata = asObject(partner.metadata);
  const state = asObject(metadata.bonus_offer_state);
  const chosen = requested || sticky || chooseLeastUsedBonusSet(sets, state);
  if (!chosen) return null;
  const token = String(chosen.token ?? "");
  const shouldCountAssignment = !requested && !sticky;
  const nextState = shouldCountAssignment
    ? { ...state, [token]: Number(state[token] ?? chosen.assigned_count ?? 0) + 1 }
    : { ...state };
  const nextSets: JsonObject = {};
  sets.forEach((set) => {
    const id = String(set.id ?? "");
    if (!id) return;
    const setToken = String(set.token ?? "");
    nextSets[id] = {
      ...set,
      assigned_count: Number(nextState[setToken] ?? set.assigned_count ?? 0),
      updated_at: setToken === token && shouldCountAssignment ? nowIso() : String(set.updated_at ?? "")
    };
  });
  if (shouldCountAssignment) {
    withReferralDb((db) => db.prepare(`
      UPDATE referral_partners
      SET metadata_json = :metadata_json, updated_at = :updated_at
      WHERE id = :id
    `).run({
      id: String(partner.id ?? ""),
      metadata_json: JSON.stringify({ ...metadata, bonus_offer_sets: nextSets, bonus_offer_state: nextState }),
      updated_at: nowIso()
    } as any));
    trackReferralEvent({
      partner_id: String(partner.id ?? ""),
      code_id: String(code.id ?? ""),
      code: String(code.code ?? ""),
      event_type: "bonus_offer_assigned",
      metadata: {
        token,
        set_id: String(chosen.id ?? ""),
        label: String(chosen.label ?? ""),
        query_key: BONUS_QUERY_KEY
      }
    });
  }
  return bonusSetPublicView({ ...chosen, assigned_count: Number(nextState[token] ?? 0) }, partner);
}

function stickyBonusSetForVisitor(partner: JsonObject, code: JsonObject, input: JsonObject, sets: JsonObject[]) {
  const visitorKey = uniqueViewKey({ id: "", metadata: attributionMetadata(input) });
  if (!visitorKey || visitorKey.startsWith("row:")) return null;
  const activeTokens = new Set(sets.map((set) => String(set.token ?? "")).filter(Boolean));
  const attributionRows = rows(`
    SELECT * FROM referral_attributions
    WHERE partner_id = :partner_id
      AND code_id = :code_id
      AND status = 'viewed'
    ORDER BY created_at DESC
    LIMIT 1000
  `, {
    partner_id: String(partner.id ?? ""),
    code_id: String(code.id ?? "")
  });
  for (const rowEntry of attributionRows) {
    if (uniqueViewKey(rowEntry) !== visitorKey) continue;
    const token = String(asObject(rowEntry.metadata).acquisition_bonus_token ?? "").trim();
    if (!token || !activeTokens.has(token)) continue;
    return sets.find((set) => String(set.token ?? "") === token) || null;
  }
  return null;
}

function chooseLeastUsedBonusSet(sets: JsonObject[], state: JsonObject) {
  const scored = sets.map((set) => ({
    set,
    count: Number(state[String(set.token ?? "")] ?? set.assigned_count ?? 0)
  }));
  if (!scored.length) return null;
  const min = Math.min(...scored.map((entry) => entry.count));
  const tied = scored.filter((entry) => entry.count === min);
  return tied[Math.floor(Math.random() * tied.length)]?.set || null;
}

function bonusSetPublicView(set: JsonObject, partner: JsonObject = {}) {
  const tiers = normalizeBonusTierSet(set.tiers);
  return {
    offer_id: ACQUISITION_BONUS_OFFER_ID,
    id: String(set.id ?? ""),
    token: String(set.token ?? ""),
    label: String(set.label ?? ""),
    campaign_id: String(partner.id ?? ""),
    campaign_name: String(partner.display_name ?? ""),
    assigned_count: Number(set.assigned_count ?? 0),
    query_key: BONUS_QUERY_KEY,
    tiers
  };
}

async function acquisitionBonusAssignmentForOrg(orgId: string) {
  if (!orgId) return null;
  const org = await readOrganization(orgId).catch(() => null);
  const metadata = asObject(org?.metadata);
  const direct = { ...asObject(metadata.acquisition_bonus_offer), ...asObject(asObject(org).acquisition_bonus_offer) };
  const orgAcquisitionMeta = { ...asObject(metadata.acquisition_metadata), ...asObject(asObject(org).acquisition_metadata) };
  const campaignId = String(direct.campaign_id ?? metadata.acquisition_campaign_id ?? asObject(org).acquisition_campaign_id ?? "").trim();
  const token = String(direct.token ?? orgAcquisitionMeta.acquisition_bonus_token ?? "").trim();
  if (!campaignId || !token) return null;
  const partner = row("SELECT * FROM referral_partners WHERE id = :id AND type = 'acquisition_campaign' LIMIT 1", { id: campaignId });
  if (!partner) return null;
  const code = primaryCodeForPartner(campaignId) || {};
  const set = findBonusSetByToken(partner, code, token);
  if (!set) {
    const fallbackTiers = Array.isArray(direct.tiers) ? direct.tiers : [];
    if (!fallbackTiers.length) return null;
    return bonusSetPublicView({ ...direct, token, tiers: fallbackTiers }, partner);
  }
  return bonusSetPublicView(set, partner);
}

function referralCodeByCode(codeValue: unknown, requireActive = false) {
  const code = String(codeValue ?? "").trim();
  if (!code) return null;
  return row(`
    SELECT * FROM referral_codes
    WHERE LOWER(code) = LOWER(:code)
      ${requireActive ? "AND (active = 1 OR status = 'active')" : ""}
    LIMIT 1
  `, { code });
}

function acquisitionLinkByLanding(input: JsonObject): JsonObject | null {
  const landingPaths = landingPathCandidates(input);
  const landingVariant = normalizedLandingVariant(input.landing_variant);
  if (!landingPaths.length && !landingVariant) return null;
  const candidates = rows(`
    SELECT rc.*, rp.metadata_json AS partner_metadata_json
    FROM referral_codes rc
    LEFT JOIN referral_partners rp ON rp.id = rc.partner_id
    WHERE rp.type = 'acquisition_campaign'
      AND (rp.status = 'active' OR rp.status = '')
      AND (rc.active = 1 OR rc.status = 'active')
    ORDER BY rc.updated_at DESC
    LIMIT 1000
  `);

  for (const candidate of candidates) {
    const metadata = { ...asObject(candidate.partner_metadata), ...asObject(candidate.metadata) };
    const pairedPaths = landingPathCandidates({
      landing_page: metadata.landing_page,
      landing_page_path: metadata.landing_page_path,
      page_path: metadata.page_path
    });
    if (pairedPaths.some((path) => landingPaths.includes(path))) return candidate ?? null;
  }

  if (!landingVariant) return null;
  const matches = candidates.filter((candidate) => {
    const metadata = { ...asObject(candidate.partner_metadata), ...asObject(candidate.metadata) };
    return normalizedLandingVariant(candidate.landing_variant) === landingVariant
      || normalizedLandingVariant(metadata.landing_variant) === landingVariant;
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function landingPathCandidates(input: JsonObject) {
  const values = [
    input.landing_page,
    input.landing_page_path,
    input.page_path,
    input.page_url,
    input.request_url
  ];
  return [...new Set(values.map(normalizeLandingPath).filter(Boolean))];
}

function normalizeLandingPath(value: unknown) {
  let text = String(value ?? "").trim();
  if (!text) return "";
  try {
    text = new URL(text, "https://app.1m8.ai").pathname;
  } catch {
    text = text.split(/[?#]/)[0] || "";
  }
  text = text.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!text.startsWith("/")) text = `/${text}`;
  if (!text.endsWith("/")) text = `${text}/`;
  return text.toLowerCase();
}

function normalizedLandingVariant(value: unknown) {
  const variant = String(value ?? "").trim().toLowerCase();
  return variant && !["landing", "landing_template", "template"].includes(variant) ? variant : "";
}

function campaignCodeFallback(value: unknown) {
  const code = String(value ?? "").trim();
  return normalizedLandingVariant(code) ? code : "";
}

function createViewedAttribution(partner: JsonObject, code: JsonObject, source: string, metadata: JsonObject = {}) {
  const now = nowIso();
  const id = generateId("refattr");
  withReferralDb((db) => db.prepare(`
    INSERT INTO referral_attributions (
      id, partner_id, code_id, referral_code, referred_org_id, referred_email, status, source, note,
      metadata_json, signup_completed_at, created_at, updated_at
    ) VALUES (
      :id, :partner_id, :code_id, :referral_code, '', '', 'viewed', :source, '',
      :metadata_json, '', :created_at, :updated_at
    )
  `).run({
    id,
    partner_id: String(partner.id ?? ""),
    code_id: String(code.id ?? ""),
    referral_code: String(code.code ?? ""),
    source,
    metadata_json: JSON.stringify({ ...metadata, source }),
    created_at: now,
    updated_at: now
  } as any));
  return id;
}

function referralInvitationCopy(partner: JsonObject, code: JsonObject) {
  const name = String(partner.display_name ?? "A referral partner").trim() || "A referral partner";
  const type = normalizePartnerType(partner.type);
  const offerId = String(code.new_org_offer_id ?? "").trim();
  return {
    headline: `${name} has invited you to try FirstMate.`,
    subheadline: type === "customer_user"
      ? "Create your account to get started with FirstMate."
      : "Create your account to get started with FirstMate through this partner invitation.",
    offer: referralNewOrgOffer(offerId)
  };
}

function referralNewOrgOffer(offerId: string) {
  if (offerId === "referral_week_discount_v1") {
    return {
      offer_id: offerId,
      label: "50% off for your first 7 days",
      description: "Get 50% off report orders for the first 7 days after you create your account.",
      discount_percent: 50,
      window_days: 7
    };
  }
  if (offerId === "referral_free_expedite_7_v1") {
    return {
      offer_id: offerId,
      label: "7 free expedite uses",
      description: "Get 7 free rush-delivery upgrades for roof reports after you create your account.",
      free_expedite_uses: 7
    };
  }
  return null;
}

async function customerReferralEligibility(orgId: string) {
  if (!orgId) return { show: false, reason: "no_org", seconds_until_eligible: 0 };
  const global = await readGlobal(orgId).catch(() => null);
  const offers = asObject(asObject(asObject(global?.data).offers).items);
  const bonus = asObject(offers.bonus_upfront_match_v1);
  const firstShownAt = String(bonus.first_shown_at ?? "").trim();
  if (!firstShownAt) return { show: false, reason: "bonus_not_shown", seconds_until_eligible: 0 };
  const firstShownMs = Date.parse(firstShownAt);
  if (!Number.isFinite(firstShownMs)) return { show: false, reason: "bad_bonus_timestamp", seconds_until_eligible: 0 };
  const eligibleMs = firstShownMs + (72 * 60 * 60 * 1000);
  const secondsUntil = Math.max(0, Math.floor((eligibleMs - Date.now()) / 1000));
  return {
    show: secondsUntil <= 0,
    reason: secondsUntil <= 0 ? "eligible" : "waiting_72h",
    bonus_first_shown_at: firstShownAt,
    eligible_at: new Date(eligibleMs).toISOString(),
    seconds_until_eligible: secondsUntil
  };
}

function ensureCustomerReferralPartner(input: { email: string; orgId: string; name: string; company: string }) {
  const email = input.email.trim().toLowerCase();
  if (!email) return null;
  const existing = row("SELECT * FROM referral_partners WHERE linked_user_email = :email AND type = 'customer_user' ORDER BY created_at ASC LIMIT 1", { email });
  if (existing) return hydratePartner(existing);
  const displayName = input.name || input.company || email;
  const saved = saveReferralPartnerSync({
    type: "customer_user",
    status: "active",
    display_name: displayName,
    company_name: input.company,
    contact_name: input.name,
    contact_email: email,
    linked_user_email: email,
    linked_org_id: input.orgId
  });
  ensurePrimaryCode(String(saved.id), displayName, "", "customer_referral_reward_v1", { campaign_type: "customer_referral", landing_variant: "customer_invite" });
  return hydratePartner(saved);
}

function saveReferralPartnerSync(input: JsonObject) {
  const now = nowIso();
  const id = String(input.id ?? "").trim() || generateId("refp");
  const displayName = String(input.display_name ?? input.name ?? "").trim();
  const existing = row("SELECT * FROM referral_partners WHERE id = :id LIMIT 1", { id });
  const partner = {
    id,
    type: normalizePartnerType(input.type),
    status: normalizePartnerStatus(input.status),
    display_name: displayName || id,
    company_name: String(input.company_name ?? "").trim(),
    contact_name: String(input.contact_name ?? "").trim(),
    contact_email: String(input.contact_email ?? "").trim().toLowerCase(),
    contact_phone: String(input.contact_phone ?? "").trim(),
    linked_user_email: String(input.linked_user_email ?? "").trim().toLowerCase(),
    linked_org_id: String(input.linked_org_id ?? "").trim(),
    logo_url: String(input.logo_url ?? "").trim(),
    logo_path: String(input.logo_path ?? "").trim(),
    notes: String(input.notes ?? "").trim(),
    metadata_json: JSON.stringify(asObject(input.metadata)),
    created_at: String(existing?.created_at ?? now),
    updated_at: now
  };
  withReferralDb((db) => db.prepare(`
    INSERT INTO referral_partners (
      id, type, status, display_name, company_name, contact_name, contact_email, contact_phone,
      linked_user_email, linked_org_id, logo_url, logo_path, notes, metadata_json, created_at, updated_at
    ) VALUES (
      :id, :type, :status, :display_name, :company_name, :contact_name, :contact_email, :contact_phone,
      :linked_user_email, :linked_org_id, :logo_url, :logo_path, :notes, :metadata_json, :created_at, :updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      status = excluded.status,
      display_name = excluded.display_name,
      company_name = excluded.company_name,
      contact_name = excluded.contact_name,
      contact_email = excluded.contact_email,
      contact_phone = excluded.contact_phone,
      linked_user_email = excluded.linked_user_email,
      linked_org_id = excluded.linked_org_id,
      logo_url = excluded.logo_url,
      logo_path = excluded.logo_path,
      notes = excluded.notes,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(partner as any));
  return normalizeRow(partner);
}

function trackReferralEvent(input: JsonObject) {
  const now = nowIso();
  const metadataInput = asObject(input.metadata);
  const eventId = String(input.event_id || metadataInput.event_id || "").trim();
  const uniqueEvent = truthy(input.unique_event) || eventId !== "";
  const event = {
    id: generateId("refevt"),
    partner_id: String(input.partner_id ?? ""),
    code_id: String(input.code_id ?? ""),
    code: String(input.code ?? ""),
    actor_email: String(input.email ?? input.actor_email ?? "").trim().toLowerCase(),
    actor_org_id: String(input.org_id ?? input.actor_org_id ?? ""),
    event_type: String(input.event_type ?? "").trim() || "event",
    event_count: 1,
    first_seen_at: now,
    last_seen_at: now,
    metadata_json: JSON.stringify({
      ...metadataInput,
      event_id: eventId,
      unique_event: uniqueEvent,
      email: String(input.email ?? ""),
      org_id: String(input.org_id ?? "")
    }),
    created_at: now,
    updated_at: now
  };
  withReferralDb((db) => {
    const existing = uniqueEvent ? null : db.prepare(`
      SELECT * FROM referral_events
      WHERE partner_id = :partner_id
        AND actor_email = :actor_email
        AND actor_org_id = :actor_org_id
        AND event_type = :event_type
      LIMIT 1
    `).get(sqliteParams(`
      SELECT * FROM referral_events
      WHERE partner_id = :partner_id
        AND actor_email = :actor_email
        AND actor_org_id = :actor_org_id
        AND event_type = :event_type
      LIMIT 1
    `, event) as any) as JsonObject | undefined;
    if (existing?.id) {
      db.prepare(`
        UPDATE referral_events
        SET code_id = ?,
            code = ?,
            event_count = COALESCE(event_count, 0) + 1,
            last_seen_at = ?,
            metadata_json = ?,
            updated_at = ?
        WHERE id = ?
      `).run(event.code_id, event.code, event.last_seen_at, event.metadata_json, event.updated_at, String(existing.id));
      event.id = String(existing.id);
      event.event_count = Number(existing.event_count ?? 0) + 1;
      event.first_seen_at = String(existing.first_seen_at ?? event.first_seen_at);
      return;
    }
    db.prepare(`
      INSERT INTO referral_events (
        id, partner_id, code_id, code, actor_email, actor_org_id, event_type,
        event_count, first_seen_at, last_seen_at, metadata_json, created_at, updated_at
      ) VALUES (
        :id, :partner_id, :code_id, :code, :actor_email, :actor_org_id, :event_type,
        :event_count, :first_seen_at, :last_seen_at, :metadata_json, :created_at, :updated_at
      )
    `).run(event as any);
  });
  return { ok: true, success: true, event };
}

export function trackAcquisitionEvent(input: JsonObject) {
  const codeValue = String(input.acquisition_code ?? input.cid ?? input.campaign_code ?? input.referral_code ?? input.code ?? input.campaign ?? "").trim();
  const code = codeValue ? referralCodeByCode(codeValue, false) : null;
  const partner = code ? row("SELECT * FROM referral_partners WHERE id = :id LIMIT 1", { id: String(code.partner_id ?? "") }) : null;
  return trackReferralEvent({
    ...input,
    partner_id: input.partner_id || partner?.id || "",
    code_id: input.code_id || code?.id || "",
    code: input.code || code?.code || codeValue,
    metadata: {
      ...attributionMetadata(input),
      ...asObject(input.metadata),
      source_type: partner && code && isReferralAcquisition(partner, code) ? "referral" : String(input.source_type || "marketing")
    }
  });
}

function ensureAcquisitionLink(input: JsonObject) {
  const rawCampaign = String(input.cid ?? input.campaign ?? input.acquisition_campaign ?? input.campaign_code ?? input.code ?? "").trim();
  const campaign = rawCampaign || "marketing";
  const codeValue = acquisitionCodeValue(campaign);
  const existing = referralCodeByCode(codeValue, false);
  if (existing) return existing;
  const now = nowIso();
  const partnerId = `acq_${slugify(campaign).slice(0, 48) || "marketing"}`;
  const existingPartner = row("SELECT * FROM referral_partners WHERE id = :id LIMIT 1", { id: partnerId });
  const partner = {
    id: partnerId,
    type: "acquisition_campaign",
    status: "active",
    display_name: String(input.display_name ?? input.name ?? campaign).trim() || campaign,
    company_name: String(input.company_name ?? "").trim(),
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    linked_user_email: "",
    linked_org_id: "",
    logo_url: "",
    logo_path: "",
    notes: "",
    metadata_json: JSON.stringify({
      ...asObject(existingPartner?.metadata),
      ...asObject(input.metadata),
      source_type: "marketing",
      campaign
    }),
    created_at: String(existingPartner?.created_at ?? now),
    updated_at: now
  };
  withReferralDb((db) => db.prepare(`
    INSERT INTO referral_partners (
      id, type, status, display_name, company_name, contact_name, contact_email, contact_phone,
      linked_user_email, linked_org_id, logo_url, logo_path, notes, metadata_json, created_at, updated_at
    ) VALUES (
      :id, :type, :status, :display_name, :company_name, :contact_name, :contact_email, :contact_phone,
      :linked_user_email, :linked_org_id, :logo_url, :logo_path, :notes, :metadata_json, :created_at, :updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      display_name = excluded.display_name,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(partner as any));
  const code = {
    id: generateId("acqlink"),
    partner_id: partnerId,
    code: codeValue,
    label: String(input.label ?? "Primary"),
    campaign_type: String(input.campaign_type ?? input.source ?? input.utm_source ?? "marketing"),
    landing_variant: String(input.landing_variant ?? ""),
    status: "active",
    active: 1,
    is_primary: 1,
    new_org_offer_id: "",
    referrer_reward_policy_id: "",
    metadata_json: JSON.stringify({
      ...asObject(input.metadata),
      source_type: "marketing",
      campaign,
      channel: String(input.channel ?? input.utm_source ?? input.source ?? ""),
      landing_page: String(input.landing_page ?? "")
    }),
    landing_views: 0,
    last_viewed_at: "",
    created_at: now,
    updated_at: now
  };
  withReferralDb((db) => db.prepare(`
    INSERT INTO referral_codes (
      id, partner_id, code, label, campaign_type, landing_variant, status, active, is_primary,
      new_org_offer_id, referrer_reward_policy_id, metadata_json, landing_views, last_viewed_at, created_at, updated_at
    ) VALUES (
      :id, :partner_id, :code, :label, :campaign_type, :landing_variant, :status, :active, :is_primary,
      :new_org_offer_id, :referrer_reward_policy_id, :metadata_json, :landing_views, :last_viewed_at, :created_at, :updated_at
    )
  `).run(code as any));
  return normalizeRow(code);
}

function attributionMetadata(input: JsonObject) {
  const metadata: JsonObject = {
    source_type: String(input.source_type ?? "").trim(),
    acquisition_campaign: String(input.acquisition_campaign ?? input.campaign ?? "").trim(),
    acquisition_code: String(input.acquisition_code ?? input.cid ?? input.campaign_code ?? input.referral_code ?? input.code ?? "").trim()
  };
  for (const field of ATTRIBUTION_FIELDS) {
    const value = input[field];
    if (value != null && String(value).trim() !== "") metadata[field] = String(value).trim();
  }
  const nested = asObject(input.metadata);
  return Object.fromEntries(Object.entries({ ...metadata, ...nested }).filter(([, value]) => String(value ?? "").trim() !== ""));
}

function isReferralAcquisition(partner: JsonObject, code: JsonObject) {
  const type = normalizePartnerType(partner.type);
  const sourceType = String(asObject(code.metadata).source_type || asObject(partner.metadata).source_type || "").toLowerCase();
  const campaignType = String(code.campaign_type || "").toLowerCase();
  return sourceType === "referral"
    || type === "manufacturer_rep"
    || type === "customer_user"
    || type === "affiliate"
    || campaignType.includes("referral");
}

function hydrateAcquisitionCampaign(partner: JsonObject): JsonObject {
  const hydrated = hydratePartner(partner);
  const code = asObject(hydrated.primary_code);
  const metadata = {
    ...asObject(partner.metadata),
    ...asObject(code.metadata)
  };
  const stats = acquisitionCampaignStats(String(partner.id ?? ""), code);
  return {
    ...hydrated,
    type: "acquisition_campaign",
    type_label: "Acquisition Campaign",
    metadata,
    landing_page: String(metadata.landing_page || metadata.landing_page_path || ""),
    landing_variant: String(code.landing_variant || metadata.landing_variant || ""),
    campaign_type: String(code.campaign_type || metadata.channel || ""),
    stats: {
      ...asObject(hydrated.stats),
      ...stats
    },
    signup_url: code.code ? acquisitionSignupUrl(code.code) : ""
  };
}

function reportRange(input: JsonObject, timezoneOffsetMinutes = 0) {
  const now = new Date();
  const startRaw = String(input.start ?? input.start_date ?? "").trim();
  const endRaw = String(input.end ?? input.end_date ?? "").trim();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 29);
  defaultStart.setHours(0, 0, 0, 0);
  const start = dateBoundary(startRaw, defaultStart, false, timezoneOffsetMinutes);
  const end = dateBoundary(endRaw, now, true, timezoneOffsetMinutes);
  if (end.getTime() < start.getTime()) return { start: end, end: start };
  return { start, end };
}

function dateBoundary(value: string, fallback: Date, endOfDay: boolean, timezoneOffsetMinutes = 0) {
  if (!value) return new Date(fallback);
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]) - 1;
    const day = Number(dateOnlyMatch[3]);
    const time = endOfDay
      ? Date.UTC(year, month, day, 23, 59, 59, 999)
      : Date.UTC(year, month, day, 0, 0, 0, 0);
    return new Date(time + timezoneOffsetMinutes * 60_000);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date(fallback);
  return date;
}

function normalizeTimezoneOffset(value: unknown) {
  const offset = Number(value ?? 0);
  if (!Number.isFinite(offset)) return 0;
  return Math.max(-840, Math.min(840, Math.round(offset)));
}

function inRange(value: string, range: { start: Date; end: Date }) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) && time >= range.start.getTime() && time <= range.end.getTime();
}

function shiftedDate(value: string | Date, timezoneOffsetMinutes = 0) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - timezoneOffsetMinutes * 60_000);
}

function dayKey(value: string | Date, timezoneOffsetMinutes = 0) {
  const date = shiftedDate(value, timezoneOffsetMinutes);
  return date ? date.toISOString().slice(0, 10) : "";
}

function hourKey(value: string | Date, timezoneOffsetMinutes = 0) {
  const date = shiftedDate(value, timezoneOffsetMinutes);
  return date ? date.getUTCHours() : -1;
}

function buildDailyTrend(range: { start: Date; end: Date }, views: JsonObject[], signups: JsonObject[], spendLedger: JsonObject[], timezoneOffsetMinutes = 0) {
  const buckets = new Map<string, JsonObject>();
  const uniqueVisitors = new Map<string, Set<string>>();
  const cursor = shiftedDate(range.start, timezoneOffsetMinutes) || new Date(range.start);
  cursor.setUTCHours(0, 0, 0, 0);
  const localEnd = shiftedDate(range.end, timezoneOffsetMinutes) || new Date(range.end);
  while (cursor.getTime() <= localEnd.getTime()) {
    const key = dayKey(cursor);
    buckets.set(key, { date: key, views: 0, unique_visitors: 0, signups: 0, spend: 0, orders: 0 });
    uniqueVisitors.set(key, new Set());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  for (const entry of views) {
    const key = dayKey(String(entry.created_at ?? ""), timezoneOffsetMinutes);
    incrementBucket(buckets, key, "views", 1);
    incrementUniqueVisitor(buckets, uniqueVisitors, key, entry);
  }
  for (const entry of signups) incrementBucket(buckets, dayKey(String(entry.signup_completed_at || entry.updated_at || entry.created_at || ""), timezoneOffsetMinutes), "signups", 1);
  for (const entry of spendLedger) {
    const key = dayKey(String(entry.ts ?? ""), timezoneOffsetMinutes);
    incrementBucket(buckets, key, "spend", Number(entry.amount ?? 0));
    incrementBucket(buckets, key, "orders", 1);
  }
  return Array.from(buckets.values());
}

function buildHourlyTrend(views: JsonObject[], signups: JsonObject[], spendLedger: JsonObject[], timezoneOffsetMinutes = 0) {
  const uniqueVisitors = Array.from({ length: 24 }, () => new Set<string>());
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, label: `${String(hour).padStart(2, "0")}:00`, views: 0, unique_visitors: 0, signups: 0, spend: 0, orders: 0 }));
  for (const entry of views) {
    const hour = hourKey(String(entry.created_at ?? ""), timezoneOffsetMinutes);
    const bucket = buckets[hour];
    if (bucket) {
      bucket.views += 1;
      const key = uniqueViewKey(entry);
      const seen = uniqueVisitors[hour];
      if (key && seen) {
        seen.add(key);
        bucket.unique_visitors = seen.size;
      }
    }
  }
  for (const entry of signups) {
    const hour = hourKey(String(entry.signup_completed_at || entry.updated_at || entry.created_at || ""), timezoneOffsetMinutes);
    const bucket = buckets[hour];
    if (bucket) bucket.signups += 1;
  }
  for (const entry of spendLedger) {
    const hour = hourKey(String(entry.ts ?? ""), timezoneOffsetMinutes);
    const bucket = buckets[hour];
    if (bucket) {
      bucket.spend += Number(entry.amount ?? 0);
      bucket.orders += 1;
    }
  }
  return buckets;
}

function incrementBucket(buckets: Map<string, JsonObject>, key: string, field: string, amount: number) {
  if (!key || !buckets.has(key)) return;
  const bucket = buckets.get(key) as JsonObject;
  bucket[field] = Number(bucket[field] ?? 0) + amount;
}

function incrementUniqueVisitor(buckets: Map<string, JsonObject>, uniqueVisitors: Map<string, Set<string>>, bucketKey: string, entry: JsonObject) {
  if (!bucketKey || !buckets.has(bucketKey)) return;
  const visitorKey = uniqueViewKey(entry);
  if (!visitorKey) return;
  const seen = uniqueVisitors.get(bucketKey) ?? new Set<string>();
  seen.add(visitorKey);
  uniqueVisitors.set(bucketKey, seen);
  const bucket = buckets.get(bucketKey) as JsonObject;
  bucket.unique_visitors = seen.size;
}

function breakdown(rowsInput: JsonObject[], keyFn: (entry: JsonObject) => string) {
  const map = new Map<string, { key: string; label: string; count: number; unique_visitors: number; signups: number; visitors: Set<string> }>();
  for (const entry of rowsInput) {
    const raw = keyFn(entry).trim() || "unknown";
    const key = raw.toLowerCase();
    const current = map.get(key) || { key, label: raw, count: 0, unique_visitors: 0, signups: 0, visitors: new Set<string>() };
    current.count += 1;
    const visitorKey = uniqueViewKey(entry);
    if (visitorKey) {
      current.visitors.add(visitorKey);
      current.unique_visitors = current.visitors.size;
    }
    if (String(entry.status ?? "") === "signup_completed") current.signups += 1;
    map.set(key, current);
  }
  return Array.from(map.values())
    .map(({ visitors: _visitors, ...entry }) => entry)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function bonusOfferBreakdown(campaigns: JsonObject[], views: JsonObject[], signups: JsonObject[], spendByOrg: Map<unknown, JsonObject>) {
  const campaignById = new Map(campaigns.map((campaign) => [String(campaign.id ?? ""), campaign]));
  const map = new Map<string, JsonObject & { visitors: Set<string> }>();
  const ensure = (entry: JsonObject) => {
    const metadata = asObject(entry.metadata);
    const token = String(metadata.acquisition_bonus_token ?? "").trim();
    if (!token) return null;
    const campaignId = String(entry.partner_id ?? metadata.campaign_id ?? "");
    const key = `${campaignId}:${token}`;
    const current = map.get(key) || {
      key,
      token,
      set_id: String(metadata.acquisition_bonus_set_id ?? ""),
      label: String(metadata.acquisition_bonus_label ?? token),
      campaign_id: campaignId,
      campaign_name: String(campaignById.get(campaignId)?.display_name ?? entry.campaign_name ?? ""),
      views: 0,
      unique_visitors: 0,
      signups: 0,
      spend: 0,
      conversion_rate: 0,
      visitors: new Set<string>()
    };
    map.set(key, current);
    return current;
  };
  for (const entry of views) {
    const current = ensure(entry);
    if (!current) continue;
    current.views = Number(current.views ?? 0) + 1;
    const visitorKey = uniqueViewKey(entry);
    if (visitorKey) {
      current.visitors.add(visitorKey);
      current.unique_visitors = current.visitors.size;
    }
  }
  for (const entry of signups) {
    const current = ensure(entry);
    if (!current) continue;
    current.signups = Number(current.signups ?? 0) + 1;
    current.spend = Number(current.spend ?? 0) + Number(spendByOrg.get(String(entry.referred_org_id ?? ""))?.spend ?? 0);
  }
  const output: JsonObject[] = Array.from(map.values()).map(({ visitors: _visitors, ...entry }) => ({
    ...entry,
    conversion_rate: Number(entry.unique_visitors ?? 0) ? Number(entry.signups ?? 0) / Number(entry.unique_visitors ?? 0) : 0
  }));
  return output.sort((a, b) => Number(b.signups ?? 0) - Number(a.signups ?? 0) || Number(b.views ?? 0) - Number(a.views ?? 0));
}

function uniqueVisitorCountForRows(entries: JsonObject[]) {
  return new Set(entries.map(uniqueViewKey).filter(Boolean)).size;
}

function uniqueViewKey(entry: JsonObject) {
  const metadata = asObject(entry.metadata);
  const ip = normalizeVisitorIp(firstNonBlank(
    metadata.landing_client_ip,
    metadata.client_ip,
    metadata.forwarded_for,
    metadata.request_ip,
    metadata.remote_address
  ));
  if (ip) return `ip:${ip}`;

  const fingerprint = [
    firstNonBlank(metadata.browser_user_agent, metadata.user_agent),
    firstNonBlank(metadata.browser_language, metadata.accept_language),
    metadata.timezone,
    metadata.screen_width,
    metadata.screen_height,
    metadata.device_pixel_ratio
  ].map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean).join("|");
  if (fingerprint) return `fp:${fingerprint}`;
  return `row:${String(entry.id ?? "")}`;
}

function normalizeVisitorIp(value: unknown) {
  let ip = String(value ?? "").trim().toLowerCase();
  if (!ip) return "";
  ip = ip.split(",")[0]?.trim() ?? "";
  ip = ip.replace(/^::ffff:/, "");
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  if (ip === "unknown" || ip === "undefined" || ip === "null") return "";
  return ip;
}

async function spendForOrganizations(orgIds: string[], range: { start: Date; end: Date }) {
  const organizations: { org_id: string; spend: number; orders: number }[] = [];
  const ledger: JsonObject[] = [];
  for (const orgId of orgIds) {
    try {
      const global = await readGlobal(orgId);
      const entries = Array.isArray(asObject(global.data).credits_ledger) ? asObject(global.data).credits_ledger as unknown[] : [];
      let spend = 0;
      let orders = 0;
      for (const rawEntry of entries) {
        const entry = asObject(rawEntry);
        const ts = String(entry.ts ?? entry.created_at ?? "");
        if (!inRange(ts, range)) continue;
        const delta = Number(entry.delta ?? 0);
        if (!Number.isFinite(delta) || delta >= 0) continue;
        const amount = Math.abs(delta);
        spend += amount;
        orders += 1;
        ledger.push({
          ...entry,
          org_id: orgId,
          amount,
          reason: String(entry.reason ?? "")
        });
      }
      organizations.push({ org_id: orgId, spend, orders });
    } catch {
      organizations.push({ org_id: orgId, spend: 0, orders: 0 });
    }
  }
  ledger.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
  return {
    total_spend: organizations.reduce((sum, entry) => sum + entry.spend, 0),
    total_orders: organizations.reduce((sum, entry) => sum + entry.orders, 0),
    organizations,
    ledger
  };
}

function hydratePartner(partner: JsonObject): JsonObject {
  const primaryCode = primaryCodeForPartner(String(partner.id ?? ""));
  return {
    ...partner,
    type_label: partnerTypeLabel(partner.type),
    primary_code: primaryCode,
    signup_url: primaryCode ? referralSignupUrl(primaryCode.code) : "",
    stats: partnerStats(String(partner.id ?? ""))
  };
}

function primaryCodeForPartner(partnerId: string) {
  return row("SELECT * FROM referral_codes WHERE partner_id = :partner_id AND is_primary = 1 LIMIT 1", { partner_id: partnerId })
    ?? row("SELECT * FROM referral_codes WHERE partner_id = :partner_id ORDER BY created_at ASC LIMIT 1", { partner_id: partnerId });
}

function ensurePrimaryCode(partnerId: string, displayName: string, offerId: string, policyId: string, extras: JsonObject = {}) {
  const existing = primaryCodeForPartner(partnerId);
  const now = nowIso();
  const code = existing ? String(existing.code ?? "") : uniqueReferralCode(displayName);
  const record = {
    id: String(existing?.id ?? generateId("refc")),
    partner_id: partnerId,
    code,
    label: String(existing?.label ?? "Primary"),
    campaign_type: String(extras.campaign_type ?? existing?.campaign_type ?? (policyId ? "customer_referral" : "manufacturer_referral")),
    landing_variant: String(extras.landing_variant ?? existing?.landing_variant ?? (policyId ? "customer_invite" : "manufacturer_invite")),
    status: "active",
    active: 1,
    is_primary: 1,
    new_org_offer_id: offerId,
    referrer_reward_policy_id: policyId,
    metadata_json: JSON.stringify({
      ...asObject(existing?.metadata),
      ...asObject(existing?.metadata_json),
      ...asObject(extras.metadata),
      source_type: String(extras.source_type ?? existing?.source_type ?? "referral"),
      channel: String(extras.channel ?? existing?.channel ?? ""),
      landing_page: String(extras.landing_page ?? existing?.landing_page ?? ""),
      acquisition_campaign: String(extras.acquisition_campaign ?? extras.campaign ?? existing?.acquisition_campaign ?? "")
    }),
    landing_views: Number(existing?.landing_views ?? 0),
    last_viewed_at: String(existing?.last_viewed_at ?? ""),
    created_at: String(existing?.created_at ?? now),
    updated_at: now
  };
  withReferralDb((db) => db.prepare(`
    INSERT INTO referral_codes (
      id, partner_id, code, label, campaign_type, landing_variant, status, active, is_primary,
      new_org_offer_id, referrer_reward_policy_id, metadata_json, landing_views, last_viewed_at, created_at, updated_at
    ) VALUES (
      :id, :partner_id, :code, :label, :campaign_type, :landing_variant, :status, :active, :is_primary,
      :new_org_offer_id, :referrer_reward_policy_id, :metadata_json, :landing_views, :last_viewed_at, :created_at, :updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      active = excluded.active,
      is_primary = excluded.is_primary,
      new_org_offer_id = excluded.new_org_offer_id,
      referrer_reward_policy_id = excluded.referrer_reward_policy_id,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run(record as any));
  return normalizeRow(record);
}

function partnerStats(partnerId: string) {
  return {
    total_views: Number(row("SELECT COUNT(*) AS count FROM referral_events WHERE partner_id = :partner_id AND event_type = 'view'", { partner_id: partnerId })?.count ?? 0),
    total_signups: Number(row("SELECT COUNT(*) AS count FROM referral_attributions WHERE partner_id = :partner_id", { partner_id: partnerId })?.count ?? 0)
  };
}

function acquisitionCampaignStats(partnerId: string, primaryCode: JsonObject) {
  return {
    total_views: Number(primaryCode.landing_views ?? 0),
    total_signups: Number(row(`
      SELECT COUNT(*) AS count
      FROM referral_attributions
      WHERE partner_id = :partner_id AND status = 'signup_completed'
    `, { partner_id: partnerId })?.count ?? 0)
  };
}

function referralSignupUrl(code: unknown, baseUrl = "") {
  const value = String(code ?? "").trim();
  if (!value) return "";
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return `${base}/portal/login.php?start=register&ref=${encodeURIComponent(value)}`;
}

function acquisitionSignupUrl(code: unknown, baseUrl = "") {
  const value = String(code ?? "").trim();
  if (!value) return "";
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return `${base}/portal/login.php?start=register&cid=${encodeURIComponent(value)}`;
}

function firstNonBlank(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function acquisitionCodeValue(campaign: string) {
  const value = String(campaign || "").trim();
  if (!value) return "";
  if (/^[A-Z0-9][A-Z0-9_-]{1,80}$/i.test(value)) return value;
  return slugify(value).toUpperCase().slice(0, 80) || uniqueReferralCode(value);
}

function slugify(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function uniqueReferralCode(displayName: string) {
  const base = (displayName || "referral")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "referral";
  let code = base;
  let suffix = 2;
  while (row("SELECT id FROM referral_codes WHERE code = :code LIMIT 1", { code })) {
    code = `${base}-${suffix}`;
    suffix += 1;
  }
  return code;
}

function rows(sql: string, params: JsonObject = {}) {
  try {
    return withReferralDb((db) => db.prepare(sql).all(sqliteParams(sql, params) as any).map((entry) => normalizeRow(entry as JsonObject)));
  } catch {
    return [];
  }
}

function row(sql: string, params: JsonObject = {}) {
  try {
    const result = withReferralDb((db) => db.prepare(sql).get(sqliteParams(sql, params) as any));
    return result ? normalizeRow(result as JsonObject) : null;
  } catch {
    return null;
  }
}

function withReferralDb<T>(fn: (db: DatabaseSync) => T): T {
  mkdirSync(referralDatabaseDir(), { recursive: true });
  const db = new DatabaseSync(referralDatabasePath());
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS referral_partners (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'manufacturer_rep',
        status TEXT NOT NULL DEFAULT 'active',
        display_name TEXT NOT NULL DEFAULT '',
        company_name TEXT NOT NULL DEFAULT '',
        contact_name TEXT NOT NULL DEFAULT '',
        contact_email TEXT NOT NULL DEFAULT '',
        contact_phone TEXT NOT NULL DEFAULT '',
        linked_user_email TEXT NOT NULL DEFAULT '',
        linked_org_id TEXT NOT NULL DEFAULT '',
        logo_url TEXT NOT NULL DEFAULT '',
        logo_path TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS referral_codes (
        id TEXT PRIMARY KEY,
        partner_id TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL DEFAULT 'Primary',
        campaign_type TEXT NOT NULL DEFAULT '',
        landing_variant TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        active INTEGER NOT NULL DEFAULT 1,
        is_primary INTEGER NOT NULL DEFAULT 0,
        new_org_offer_id TEXT NOT NULL DEFAULT '',
        referrer_reward_policy_id TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        landing_views INTEGER NOT NULL DEFAULT 0,
        last_viewed_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS referral_attributions (
        id TEXT PRIMARY KEY,
        partner_id TEXT NOT NULL,
        code_id TEXT NOT NULL,
        referral_code TEXT NOT NULL DEFAULT '',
        referred_org_id TEXT NOT NULL DEFAULT '',
        referred_email TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'signup_completed',
        source TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        signup_completed_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS referral_reward_ledger (
        id TEXT PRIMARY KEY,
        attribution_id TEXT NOT NULL,
        partner_id TEXT NOT NULL,
        code_id TEXT NOT NULL DEFAULT '',
        reward_type TEXT NOT NULL DEFAULT 'gift_card',
        amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS referral_events (
        id TEXT PRIMARY KEY,
        partner_id TEXT NOT NULL DEFAULT '',
        code_id TEXT NOT NULL DEFAULT '',
        code TEXT NOT NULL DEFAULT '',
        actor_email TEXT NOT NULL DEFAULT '',
        actor_org_id TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL DEFAULT '',
        event_count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_referral_codes_partner ON referral_codes(partner_id);
      CREATE INDEX IF NOT EXISTS idx_referral_attributions_partner ON referral_attributions(partner_id);
      CREATE INDEX IF NOT EXISTS idx_referral_attributions_org ON referral_attributions(referred_org_id);
      CREATE INDEX IF NOT EXISTS idx_referral_rewards_attribution ON referral_reward_ledger(attribution_id);
    `);
    ensureReferralColumns(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function ensureReferralColumns(db: DatabaseSync) {
  for (const sql of [
    "ALTER TABLE referral_partners ADD COLUMN linked_org_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_codes ADD COLUMN label TEXT NOT NULL DEFAULT 'Primary'",
    "ALTER TABLE referral_codes ADD COLUMN campaign_type TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_codes ADD COLUMN landing_variant TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_codes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE referral_codes ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE referral_codes ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE referral_codes ADD COLUMN landing_views INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE referral_codes ADD COLUMN last_viewed_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_attributions ADD COLUMN referral_code TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_attributions ADD COLUMN source TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_attributions ADD COLUMN note TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_attributions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE referral_events ADD COLUMN code TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_events ADD COLUMN actor_email TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_events ADD COLUMN actor_org_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_events ADD COLUMN event_count INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE referral_events ADD COLUMN first_seen_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_events ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_events ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE referral_events ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''"
  ]) {
    try { db.exec(sql); } catch {}
  }
}

function normalizeRow(rowValue: JsonObject) {
  const next = { ...rowValue };
  for (const key of Object.keys(next)) {
    if (!key.endsWith("_json") || typeof next[key] !== "string") continue;
    try {
      next[key.replace(/_json$/, "")] = JSON.parse(String(next[key] || "{}"));
    } catch {
      next[key.replace(/_json$/, "")] = {};
    }
  }
  return next;
}

function sqliteParams(sql: string, params: JsonObject) {
  return Object.fromEntries(Object.entries(params).filter(([key]) => {
    const bare = key.replace(/^[:@$]/, "");
    return sql.includes(`:${bare}`) || sql.includes(`$${bare}`) || sql.includes(`@${bare}`);
  }));
}

function crmStorageRoot() {
  return path.resolve(process.cwd(), process.env.CRM_STORAGE_ROOT ?? "storage/crm");
}

function referralDatabaseDir() {
  return path.join(crmStorageRoot(), "databases");
}

function referralDatabasePath() {
  return path.join(referralDatabaseDir(), "referrals.sqlite");
}

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizePartnerType(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  return ["manufacturer_rep", "customer_user", "affiliate", "acquisition_campaign"].includes(raw) ? raw : "manufacturer_rep";
}

function normalizePartnerStatus(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  return ["active", "archived", "disabled", "inactive"].includes(raw) ? raw : "active";
}

function normalizeRewardStatus(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  return ["pending", "approved", "sent", "void"].includes(raw) ? raw : "pending";
}

function partnerTypeLabel(value: unknown) {
  const raw = String(value ?? "manufacturer_rep");
  if (raw === "customer_user") return "Customer / User";
  if (raw === "affiliate") return "Affiliate";
  if (raw === "acquisition_campaign") return "Acquisition Campaign";
  return "Manufacturer / Rep";
}

function truthy(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function logoExtension(filename: string, mimeType: string) {
  const ext = path.extname(filename || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) return ext;
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/svg+xml") return ".svg";
  return ".bin";
}
