import { config as loadDotEnv } from "dotenv";
import { hostname } from "node:os";
import { azureMapsProviderKey, geminiProviderKey, googleProviderKey, internalApiSecret } from "./provider_keys.js";

loadDotEnv();

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalNonNegativeInteger(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function readCsv(name: string): readonly string[] {
  return String(process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readDatabaseMode(): "sqlite" | "postgres" {
  const raw = String(process.env.FIRSTMEASURE_DATABASE_MODE ?? "").trim().toLowerCase();
  if (raw === "sqlite" || raw === "postgres") return raw;
  return String(process.env.DATABASE_URL ?? "").trim() ? "postgres" : "sqlite";
}

function readDeploymentTopology(): "single" | "cluster" {
  return String(process.env.DEPLOYMENT_TOPOLOGY ?? "single").trim().toLowerCase() === "cluster"
    ? "cluster"
    : "single";
}

function readArtifactStorageMode(): "local" | "spaces" {
  return String(process.env.FIRSTMEASURE_ARTIFACT_STORAGE ?? "local").trim().toLowerCase() === "spaces"
    ? "spaces"
    : "local";
}

function readNodeRole(): "web" | "worker" | "legacy" {
  const value = String(process.env.CLUSTER_NODE_ROLE ?? "web").trim().toLowerCase();
  return value === "worker" || value === "legacy" ? value : "web";
}

type AppEnv = "development" | "staging" | "production" | "test";

export type DataEnvironment = "development" | "production" | "test";

function readAppEnv(): AppEnv {
  const raw = (process.env.FIRSTMATE_ENV ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
  if (raw === "prod") return "production";
  if (raw === "stage") return "staging";
  if (raw === "staging" || raw === "production" || raw === "test") return raw;
  return "development";
}

function readDataEnvironment(appEnvironment: AppEnv): DataEnvironment {
  const raw = String(process.env.FIRSTMEASURE_DATA_ENVIRONMENT ?? "").trim().toLowerCase();
  if (raw === "development" || raw === "production" || raw === "test") return raw;
  if (appEnvironment === "test") return "test";
  return appEnvironment === "production" ? "production" : "development";
}

function trimTrailingSlashes(value: string) { return value.replace(/\/+$/, ""); }
const appEnv = readAppEnv();
const publicBaseUrl = trimTrailingSlashes(process.env.PUBLIC_BASE_URL ?? (appEnv === "production" ? "https://app.1m8.ai" : "http://127.0.0.1:8011"));
const corsOrigins = String(process.env.CORS_ALLOWED_ORIGINS ?? (appEnv === "production" ? "https://app.1m8.ai" : "http://127.0.0.1:8011,http://localhost:8011")).split(",").map(value => value.trim()).filter(Boolean);
const dataEnvironment = readDataEnvironment(appEnv);

export const env = {
  publicBaseUrl,
  corsOrigins,
  nodeEnv: process.env.NODE_ENV ?? "development",
  appEnv,
  isDevelopment: appEnv === "development",
  isStaging: appEnv === "staging",
  isProduction: appEnv === "production",
  isTest: appEnv === "test",
  dataEnvironment,
  dataEnvironmentExplicit: Boolean(String(process.env.FIRSTMEASURE_DATA_ENVIRONMENT ?? "").trim()),
  requireDataEnvironmentMarker: readBoolean("FIRSTMEASURE_REQUIRE_DATA_ENVIRONMENT_MARKER", false),
  deploymentTopology: readDeploymentTopology(),
  clusterNodeRole: readNodeRole(),
  instanceId: String(process.env.INSTANCE_ID ?? process.env.DROPLET_ID ?? hostname()).trim(),
  releaseId: String(process.env.RELEASE_ID ?? process.env.GIT_COMMIT ?? "development").trim(),
  readinessCacheMs: readNumber("READINESS_CACHE_MS", 2_000),
  readinessDependencyTimeoutMs: readNumber("READINESS_DEPENDENCY_TIMEOUT_MS", 2_000),
  rollingDrainMs: readNumber("ROLLING_DRAIN_MS", 25_000),
  legacyServiceUrl: String(process.env.LEGACY_SERVICE_URL ?? "").trim().replace(/\/$/, ""),
  legacyProxySecret: String(process.env.LEGACY_PROXY_SECRET ?? "").trim(),
  firstmeasureArtifactStorage: readArtifactStorageMode(),
  spacesEndpoint: String(process.env.SPACES_ENDPOINT ?? "").trim().replace(/\/$/, ""),
  spacesRegion: String(process.env.SPACES_REGION ?? "").trim(),
  spacesBucket: String(process.env.SPACES_BUCKET ?? "").trim(),
  spacesAccessKeyId: String(process.env.SPACES_ACCESS_KEY_ID ?? "").trim(),
  spacesSecretAccessKey: String(process.env.SPACES_SECRET_ACCESS_KEY ?? "").trim(),
  spacesForcePathStyle: readBoolean("SPACES_FORCE_PATH_STYLE", false),
  spacesPrefix: String(process.env.SPACES_PREFIX ?? "firstmeasure").trim().replace(/^\/+|\/+$/g, ""),
  spacesReadFallbackPrefix: String(process.env.SPACES_READ_FALLBACK_PREFIX ?? "").trim().replace(/^\/+|\/+$/g, ""),
  cloneSyncStatePath: process.env.FIRSTMEASURE_CLONE_SYNC_STATE_PATH ?? "./storage/migration/artifact-sync.sqlite",
  statsigEnvironmentTier: appEnv === "production" ? "production" : appEnv === "staging" ? "staging" : "development",
  host: process.env.V1_HOST ?? "127.0.0.1",
  // Production has historically been proxied to 3101. Local launchers explicitly
  // set 3111 when they need to coexist with FirstMate 2.0.
  port: readNumber("V1_PORT", 3101),
  logLevel: process.env.V1_LOG_LEVEL ?? "info",
  webWorkers: readOptionalNonNegativeInteger("V1_WEB_WORKERS"),
  webWorkerHeartbeatIntervalMs: readNumber("V1_WORKER_HEARTBEAT_INTERVAL_MS", 5_000),
  webWorkerHeartbeatTimeoutMs: readNumber("V1_WORKER_HEARTBEAT_TIMEOUT_MS", 30_000),
  webWorkerStartupTimeoutMs: readNumber("V1_WORKER_STARTUP_TIMEOUT_MS", 120_000),
  webWorkerRestartBaseDelayMs: readNumber("V1_WORKER_RESTART_BASE_DELAY_MS", 250),
  webWorkerRestartMaxDelayMs: readNumber("V1_WORKER_RESTART_MAX_DELAY_MS", 30_000),
  webWorkerCrashWindowMs: readNumber("V1_WORKER_CRASH_WINDOW_MS", 60_000),
  webWorkerCrashLimit: readNumber("V1_WORKER_CRASH_LIMIT", 20),
  firstmeasureJobWorkers: readOptionalNonNegativeInteger("FIRSTMEASURE_JOB_WORKERS"),
  firstmeasureStorageRoot: process.env.FIRSTMEASURE_STORAGE_ROOT ?? "./storage/firstmeasure",
  weatherStorageRoot: process.env.WEATHER_STORAGE_ROOT ?? "./storage/weather",
  codeReportStorageRoot: process.env.CODE_REPORT_STORAGE_ROOT ?? "./storage/code-reports",
  firstmeasureIndexDbPath: process.env.FIRSTMEASURE_INDEX_DB_PATH ?? "./storage/firstmeasure/projects_index.sqlite",
  firstmeasureDatabaseMode: readDatabaseMode(),
  firstmeasureSqliteBusyTimeoutMs: readNumber("FIRSTMEASURE_SQLITE_BUSY_TIMEOUT_MS", 15_000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  databaseAdminUrl: process.env.DATABASE_ADMIN_URL ?? "",
  databaseCaCertPath: process.env.DATABASE_CA_CERT_PATH ?? "",
  // Each clustered web process owns a pool. One connection per process gives
  // 44-way SQL concurrency without exceeding the managed database's connection
  // budget (a default of 4 would reserve 176 connections on a 44-worker host).
  postgresPoolMax: readNumber("POSTGRES_POOL_MAX", 1),
  postgresConnectionTimeoutMs: readNumber("POSTGRES_CONNECTION_TIMEOUT_MS", 10_000),
  postgresIdleTimeoutMs: readNumber("POSTGRES_IDLE_TIMEOUT_MS", 30_000),
  postgresStatementTimeoutMs: readNumber("POSTGRES_STATEMENT_TIMEOUT_MS", 30_000),
  postgresStartupWaitMs: readNumber("POSTGRES_STARTUP_WAIT_MS", 30 * 60_000),
  postgresStartupPollMs: readNumber("POSTGRES_STARTUP_POLL_MS", 1_000),
  postgresMigrationBatchSize: readNumber("POSTGRES_MIGRATION_BATCH_SIZE", 250),
  postgresAutoMigrate: readBoolean("POSTGRES_AUTO_MIGRATE", true),
  postgresAllowEmptyImport: readBoolean("POSTGRES_ALLOW_EMPTY_IMPORT", appEnv !== "production"),
  postgresImportMaxInvalidManifests: readOptionalNonNegativeInteger("POSTGRES_IMPORT_MAX_INVALID_MANIFESTS")
    ?? (appEnv === "production" ? 100 : 0),
  platformStorageRoot: process.env.PLATFORM_STORAGE_ROOT ?? "./storage/platform",
  internalStorageRoot: process.env.INTERNAL_STORAGE_ROOT ?? "./storage/internal",
  crmStorageRoot: process.env.CRM_STORAGE_ROOT ?? "./storage/crm",
  canvassingStorageRoot: process.env.CANVASSING_STORAGE_ROOT ?? "./storage/canvassing",
  platformSessionCookieName: process.env.PLATFORM_SESSION_COOKIE_NAME ?? "fm_platform_session",
  platformSessionSecret: process.env.PLATFORM_SESSION_SECRET ?? process.env.DEV_CONSOLE_SESSION_SECRET ?? process.env.DEV_CONSOLE_PASSWORD ?? "firstmate-local-dev-session-secret",
  platformSessionTtlSeconds: readNumber("PLATFORM_SESSION_TTL_SECONDS", 60 * 60 * 24 * 7),
  emailInboundDomain: process.env.EMAIL_INBOUND_DOMAIN ?? "1m8.ai",
  emailInboundWebhookToken: process.env.EMAIL_INBOUND_WEBHOOK_TOKEN ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiLeadModel: process.env.OPENAI_LEAD_MODEL ?? "gpt-5-nano",
  googleMapsApiKey: googleProviderKey("server") || process.env.GOOGLE_MAPS_API_KEY || process.env.FIRSTMEASURE_GOOGLE_API_KEY || process.env.GOOGLE_SOLAR_API_KEY || "",
  googleBrowserApiKey: googleProviderKey("browser") || process.env.GOOGLE_BROWSER_API_KEY || "",
  googleSolarApiKey: googleProviderKey("solar") || process.env.GOOGLE_SOLAR_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "",
  googleMapsStaticApiKey: googleProviderKey("maps_static") || process.env.GOOGLE_MAPS_STATIC_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "",
  googleMapTilesApiKey: googleProviderKey("map_tiles") || process.env.GOOGLE_MAP_TILES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "",
  googlePlacesApiKey: googleProviderKey("places") || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "",
  azureMapsSubscriptionKey: azureMapsProviderKey() || process.env.AZURE_MAPS_SUBSCRIPTION_KEY || "",
  googleAuthClientId: process.env.GOOGLE_AUTH_CLIENT_ID ?? "559396801204-jnlgd52pr4q45li0tp8lda4jakqg8ccu.apps.googleusercontent.com",
  geminiApiKey: geminiProviderKey() || process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
  firstMeasureInternalApiSecret: internalApiSecret() || process.env.FIRSTMEASURE_INTERNAL_API_SECRET || "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
  devConsolePath: process.env.DEV_CONSOLE_PATH ?? "/v1/_dev/console",
  devConsoleUsername: process.env.DEV_CONSOLE_USERNAME ?? "",
  devConsolePassword: process.env.DEV_CONSOLE_PASSWORD ?? "",
  devConsoleSessionSecret: process.env.DEV_CONSOLE_SESSION_SECRET ?? process.env.DEV_CONSOLE_PASSWORD ?? "",
  pricebookStorageRoot: process.env.PRICEBOOK_STORAGE_ROOT ?? "./storage/pricebook",
  stripeTestMode: process.env.STRIPE_TEST_MODE === "1" || process.env.STRIPE_TEST_MODE === "true",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripeTestSecretKey: process.env.STRIPE_TEST_SECRET_KEY ?? "",
  stripeLiveSecretKey: process.env.STRIPE_LIVE_SECRET_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  stripeTestWebhookSecret: process.env.STRIPE_TEST_WEBHOOK_SECRET ?? "",
  stripeLiveWebhookSecret: process.env.STRIPE_LIVE_WEBHOOK_SECRET ?? "",
  stripePriceId: process.env.STRIPE_PRICE_ID ?? "",
  stripeTestPriceId: process.env.STRIPE_TEST_PRICE_ID ?? "price_1SsXkOLZgCRkHjNQCJvblXWT",
  stripeLivePriceId: process.env.STRIPE_LIVE_PRICE_ID ?? "price_1SsXlVLsVt78N4NAWbEg84Dq",
  stripeBonusPriceId: process.env.STRIPE_BONUS_PRICE_ID ?? "",
  stripeTestBonusPriceId: process.env.STRIPE_TEST_BONUS_PRICE_ID ?? "price_1SsXkOLZgCRkHjNQCJvblXWT",
  stripeLiveBonusPriceId: process.env.STRIPE_LIVE_BONUS_PRICE_ID ?? "price_1T7fn4LsVt78N4NA41Qptrzt",
  stripeBaseUrl: process.env.STRIPE_BASE_URL ?? "https://app.1m8.ai/portal",
  metaPixelId: process.env.META_PIXEL_ID ?? process.env.FB_PIXEL_ID ?? "636685175264715",
  metaCapiAccessToken: process.env.META_CAPI_ACCESS_TOKEN ?? process.env.FB_CAPI_ACCESS_TOKEN ?? "",
  metaCapiVersion: process.env.META_CAPI_VERSION ?? process.env.FB_CAPI_VERSION ?? "v21.0",
  metaCapiTestEventCode: process.env.META_CAPI_TEST_EVENT_CODE ?? process.env.FB_CAPI_TEST_EVENT_CODE ?? "",
  metaCapiTestMode: process.env.META_CAPI_TEST_MODE === "1" || process.env.META_CAPI_TEST_MODE === "true",
  statsigEnabled: process.env.STATSIG_ENABLED === "1" || process.env.STATSIG_ENABLED === "true",
  statsigClientKey: process.env.STATSIG_CLIENT_KEY ?? "",
  postmarkServerToken: process.env.POSTMARK_SERVER_TOKEN ?? process.env.POSTMARK_TOKEN ?? "",
  postmarkFrom: process.env.POSTMARK_FROM ?? "noreply@1m8.ai",
  postmarkReplyTo: process.env.POSTMARK_REPLY_TO ?? "support@1m8.ai",
  developmentEmailMode: String(process.env.DEVELOPMENT_EMAIL_MODE ?? "block").trim().toLowerCase(),
  developmentEmailAllowedDomains: readCsv("DEVELOPMENT_EMAIL_ALLOWED_DOMAINS"),
  developmentEmailCatchall: String(process.env.DEVELOPMENT_EMAIL_CATCHALL ?? "").trim().toLowerCase(),
  developmentSmsMode: String(process.env.DEVELOPMENT_SMS_MODE ?? "block").trim().toLowerCase(),
  developmentSmsAllowedE164: readCsv("DEVELOPMENT_SMS_ALLOWED_E164"),
  developmentWorkerEnabled: readBoolean("DEVELOPMENT_WORKER_ENABLED", false),
  telnyxApiKey: process.env.TELNYX_API_KEY ?? "",
  telnyxBaseUrl: process.env.TELNYX_BASE_URL ?? "https://api.telnyx.com/v2",
  telnyxVerifyProfileId: process.env.TELNYX_VERIFY_PROFILE_ID ?? "",
  telnyxRequestTimeoutMs: readNumber("TELNYX_REQUEST_TIMEOUT_MS", 10_000),
  // Additional platform services share the production runtime configuration.
  messagingStorageRoot: process.env.MESSAGING_STORAGE_ROOT ?? "./storage/messaging",
  channelsStorageRoot: process.env.CHANNELS_STORAGE_ROOT ?? "./storage/channels",
  callsStorageRoot: process.env.CALLS_STORAGE_ROOT ?? "./storage/calls",
  callsProvider: process.env.CALLS_PROVIDER === "livekit" ? "livekit" : "browser-peer",
  callsIceServersJson: process.env.CALLS_ICE_SERVERS_JSON ?? "",
  callsMaxParticipants: readNumber("CALLS_MAX_PARTICIPANTS", 25),
  callsRoomEmptyTimeoutSeconds: readNumber("CALLS_ROOM_EMPTY_TIMEOUT_SECONDS", 300),
  callsRecordingBucket: process.env.CALLS_RECORDING_BUCKET ?? "",
  callsRecordingRegion: process.env.CALLS_RECORDING_REGION ?? process.env.AWS_REGION ?? "",
  livekitUrl: trimTrailingSlashes(process.env.LIVEKIT_URL ?? ""),
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? "",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? "",
  messagingEncryptionKey: process.env.MESSAGING_ENCRYPTION_KEY ?? "",
  domainsDeliveryMode: process.env.DOMAINS_DELIVERY_MODE === "live" ? "live" : "test",
  domainsOrderTestMode: readBoolean("DOMAINS_ORDER_TEST_MODE", false),
  openSrsLiveUsername: process.env.OPENSRS_LIVE_USERNAME ?? process.env.OPENSRS_USERNAME ?? "",
  openSrsLiveApiKey: process.env.OPENSRS_LIVE_API_KEY ?? process.env.OPENSRS_API_KEY ?? "",
  openSrsTestUsername: process.env.OPENSRS_TEST_USERNAME ?? "",
  openSrsTestApiKey: process.env.OPENSRS_TEST_API_KEY ?? "",
  openSrsLiveEndpoint: process.env.OPENSRS_LIVE_ENDPOINT ?? "https://rr-n1-tor.opensrs.net:55443",
  openSrsTestEndpoint: process.env.OPENSRS_TEST_ENDPOINT ?? "https://horizon.opensrs.net:55443",
  openSrsRequestTimeoutMs: readNumber("OPENSRS_REQUEST_TIMEOUT_MS", 20_000),
  openSrsMaxStandardRegistrationPriceUsd: process.env.OPENSRS_MAX_STANDARD_REGISTRATION_PRICE_USD ?? "50.00",
  openSrsPrivacyPriceUsd: process.env.OPENSRS_PRIVACY_PRICE_USD ?? "3.00",
  domainsRetailMarkupMultiplier: readNumber("DOMAINS_RETAIL_MARKUP_MULTIPLIER", 1.5),
  domainsEncryptionKey: process.env.DOMAINS_ENCRYPTION_KEY ?? "",
  domainInfrastructureMode: process.env.DOMAIN_INFRASTRUCTURE_MODE === "live" ? "live" : "capture",
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  cloudflareApiBaseUrl: trimTrailingSlashes(process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4"),
  cloudflareWebsiteTarget: process.env.CLOUDFLARE_WEBSITE_TARGET ?? "",
  communicationsDeliveryMode: process.env.COMMUNICATIONS_DELIVERY_MODE === "live" ? "live" : "capture",
  openaiTranscriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe",
  openaiTranscriptionTimeoutMs: readNumber("OPENAI_TRANSCRIPTION_TIMEOUT_MS", 90_000),
  openaiAudioStructureModel: process.env.OPENAI_AUDIO_STRUCTURE_MODEL ?? "gpt-realtime-2.1-mini",
  openaiAudioStructureTimeoutMs: readNumber("OPENAI_AUDIO_STRUCTURE_TIMEOUT_MS", 45_000),
  openaiTranslationModel: process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-5.4-nano",
  openaiTranslationTimeoutMs: readNumber("OPENAI_TRANSLATION_TIMEOUT_MS", 12_000),
  openaiReceiptModel: process.env.OPENAI_RECEIPT_MODEL ?? "gpt-5.6-luna",
  openaiReceiptTimeoutMs: readNumber("OPENAI_RECEIPT_TIMEOUT_MS", 45_000),
  openaiDocumentModel: process.env.OPENAI_DOCUMENT_MODEL ?? process.env.OPENAI_RECEIPT_MODEL ?? "gpt-5.6-luna",
  openaiDocumentTimeoutMs: readNumber("OPENAI_DOCUMENT_TIMEOUT_MS", 60_000),
  openaiTerminologyModel: process.env.OPENAI_TERMINOLOGY_MODEL ?? process.env.OPENAI_RECEIPT_MODEL ?? "gpt-5.6-luna",
  // The scope-manager ("Automations") agent. Start on the strongest model at
  // high reasoning effort; dial down via env as cost testing progresses.
  openaiScopeAgentModel: process.env.OPENAI_SCOPE_AGENT_MODEL ?? "gpt-5.6-sol",
  openaiScopeAgentEffort: process.env.OPENAI_SCOPE_AGENT_EFFORT ?? "high",
  openaiScopeAgentTimeoutMs: readNumber("OPENAI_SCOPE_AGENT_TIMEOUT_MS", 120_000),
  // The stats analyst agent mirrors the scope agent's model/effort defaults.
  openaiStatsAgentModel: process.env.OPENAI_STATS_AGENT_MODEL ?? process.env.OPENAI_SCOPE_AGENT_MODEL ?? "gpt-5.6-sol",
  openaiStatsAgentEffort: process.env.OPENAI_STATS_AGENT_EFFORT ?? process.env.OPENAI_SCOPE_AGENT_EFFORT ?? "high",
  openaiStatsAgentTimeoutMs: readNumber("OPENAI_STATS_AGENT_TIMEOUT_MS", 120_000),
  openaiTerminologyTimeoutMs: readNumber("OPENAI_TERMINOLOGY_TIMEOUT_MS", 30_000),
  // The global platform assistant mirrors the scope agent's model/effort
  // defaults (gpt-5.6-sol at high effort across the board).
  openaiAssistantAgentModel: process.env.OPENAI_ASSISTANT_AGENT_MODEL ?? "gpt-6-luna",
  openaiAssistantAgentEffort: process.env.OPENAI_ASSISTANT_AGENT_EFFORT ?? "medium",
  openaiAssistantAgentTimeoutMs: readNumber("OPENAI_ASSISTANT_AGENT_TIMEOUT_MS", 150_000),
  // The document designer agent (workflow/template/document copilot) mirrors
  // the assistant defaults; it emits whole definitions so it gets a generous
  // output budget via its loop config rather than a different model.
  openaiDocsAgentModel: process.env.OPENAI_DOCS_AGENT_MODEL ?? process.env.OPENAI_ASSISTANT_AGENT_MODEL ?? process.env.OPENAI_SCOPE_AGENT_MODEL ?? "gpt-5.6-sol",
  openaiDocsAgentEffort: process.env.OPENAI_DOCS_AGENT_EFFORT ?? "medium",
  openaiDocsAgentTimeoutMs: readNumber("OPENAI_DOCS_AGENT_TIMEOUT_MS", 150_000),
  // The live chat agent answers website visitors conversationally; medium
  // effort and a short timeout keep replies snappy.
  openaiChatAgentModel: process.env.OPENAI_CHAT_AGENT_MODEL ?? process.env.OPENAI_SCOPE_AGENT_MODEL ?? "gpt-5.6-sol",
  openaiChatAgentEffort: process.env.OPENAI_CHAT_AGENT_EFFORT ?? "medium",
  openaiChatAgentTimeoutMs: readNumber("OPENAI_CHAT_AGENT_TIMEOUT_MS", 60_000),
  chatAiOrganizationDailyLimit: readNumber("CHAT_AI_ORGANIZATION_DAILY_LIMIT", 500),
  platformMailDomain: process.env.PLATFORM_MAIL_DOMAIN ?? "1m8.ai",
  // FirstMate Mail — the customer-facing email engine (org inboxes at
  // <slug>@firstmatemail.com). Capture mode records every send as a test-mode
  // message; test/live use Cloudflare Email Service.
  firstmateMailDomain: process.env.FIRSTMATE_MAIL_DOMAIN ?? "firstmatemail.com",
  // capture persists only; test sends through Cloudflare with a forced safe-domain
  // recipient rewrite; live sends to the requested recipients unchanged.
  emailDeliveryMode: process.env.EMAIL_DELIVERY_MODE === "live"
    ? "live"
    : process.env.EMAIL_DELIVERY_MODE === "test" ? "test" : "capture",
  // Backend-only development safety gate. Every API/UI/automation send path
  // reaches the Cloudflare provider after this configuration is applied.
  emailTestRecipientRewrite: readBoolean("EMAIL_TEST_RECIPIENT_REWRITE", false),
  emailTestRecipientDomain: process.env.EMAIL_TEST_RECIPIENT_DOMAIN ?? "1m8.ai",
  cloudflareEmailWorkerUrl: process.env.CLOUDFLARE_EMAIL_WORKER_URL ?? "https://firstmate-email-router.jack-8a9.workers.dev/outbound",
  cloudflareEmailWorkerToken: process.env.CLOUDFLARE_EMAIL_WORKER_TOKEN ?? "",
  emailOrganizationHourlyLimit: readNumber("EMAIL_ORGANIZATION_HOURLY_LIMIT", 500),
  emailOrganizationDailyLimit: readNumber("EMAIL_ORGANIZATION_DAILY_LIMIT", 2_000),
  emailTenantMinimumReputationSample: readNumber("EMAIL_TENANT_MINIMUM_REPUTATION_SAMPLE", 50),
  emailTenantBounceRateLimit: readNumber("EMAIL_TENANT_BOUNCE_RATE_LIMIT", 0.05),
  emailTenantComplaintRateLimit: readNumber("EMAIL_TENANT_COMPLAINT_RATE_LIMIT", 0.001),
  // Comms agent (project communications AI) mirrors the assistant defaults.
  openaiCommsAgentModel: process.env.OPENAI_COMMS_AGENT_MODEL ?? process.env.OPENAI_ASSISTANT_AGENT_MODEL ?? process.env.OPENAI_SCOPE_AGENT_MODEL ?? "gpt-5.6-sol",
  openaiCommsAgentEffort: process.env.OPENAI_COMMS_AGENT_EFFORT ?? "medium",
  openaiCommsAgentTimeoutMs: readNumber("OPENAI_COMMS_AGENT_TIMEOUT_MS", 120_000),
  commsAutoReplyOrganizationDailyLimit: readNumber("COMMS_AUTO_REPLY_ORGANIZATION_DAILY_LIMIT", 200),
  // Forward (managed PayFac) merchant processing for org customer payments.
  // Distinct from Stripe, which is FirstMate's own SaaS billing.
  // TODO: confirm the real sandbox API host with the Forward rep — their docs
  // use `<api-host>` placeholders; this default is an unverified guess.
  forwardApiBase: trimTrailingSlashes(process.env.FORWARD_API_BASE ?? "https://api.sandbox.getfwd.com"),
  forwardPublicKey: process.env.FORWARD_PUBLIC_KEY ?? "",
  forwardPrivateKey: process.env.FORWARD_PRIVATE_KEY ?? "",
  forwardWebhookSecret: process.env.FORWARD_WEBHOOK_SECRET ?? "",
  forwardRequestTimeoutMs: readNumber("FORWARD_REQUEST_TIMEOUT_MS", 20_000),
  forwardWebhookToleranceSeconds: readNumber("FORWARD_WEBHOOK_TOLERANCE_SECONDS", 300),
  telnyxWebhookPublicKey: process.env.TELNYX_WEBHOOK_PUBLIC_KEY ?? "",
  telnyxMessagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID ?? "",
  telnyxWebhookUrl: process.env.TELNYX_WEBHOOK_URL ?? `${publicBaseUrl}/v1/messaging/webhooks/telnyx`,
  telnyxWebhookFailoverUrl: process.env.TELNYX_WEBHOOK_FAILOVER_URL ?? "",
  telnyxWebhookToleranceSeconds: readNumber("TELNYX_WEBHOOK_TOLERANCE_SECONDS", 300),
  telnyxDailySpendLimit: process.env.TELNYX_DAILY_SPEND_LIMIT ?? "100.00",
  telnyxStandardBrandRegistrationFeeUsd: process.env.TELNYX_STANDARD_BRAND_REGISTRATION_FEE_USD ?? process.env.TELNYX_BRAND_REGISTRATION_FEE_USD ?? "4.50",
  telnyxSoleProprietorBrandRegistrationFeeUsd: process.env.TELNYX_SOLE_PROPRIETOR_BRAND_REGISTRATION_FEE_USD ?? "4.00",
  telnyxCampaignReviewFeeUsd: process.env.TELNYX_CAMPAIGN_REVIEW_FEE_USD ?? "15.00",
  smsRequireConsent: readBoolean("SMS_REQUIRE_CONSENT", true),
  smsDeliveryMaxAttempts: readNumber("SMS_DELIVERY_MAX_ATTEMPTS", 5),
  smsOrganizationDailyLimit: readNumber("SMS_ORGANIZATION_DAILY_LIMIT", 10_000),
  smsRecipientDailyLimit: readNumber("SMS_RECIPIENT_DAILY_LIMIT", 25),
  smsMarketingRecipientDailyLimit: readNumber("SMS_MARKETING_RECIPIENT_DAILY_LIMIT", 5)


} as const;
