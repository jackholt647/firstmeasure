import { env } from "./config/env.js";

type EmailGuardInput = {
  recipients: readonly string[];
  subject: string;
};

type SafetyCounters = {
  email_allowed: number;
  email_rewritten: number;
  email_blocked: number;
  sms_allowed: number;
  sms_blocked: number;
};

const counters: SafetyCounters = {
  email_allowed: 0,
  email_rewritten: 0,
  email_blocked: 0,
  sms_allowed: 0,
  sms_blocked: 0
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function emailDomain(value: string) {
  return normalizeEmail(value).split("@").pop() ?? "";
}

function configuredStripeKey() {
  return clean(env.stripeSecretKey || (env.stripeTestMode ? env.stripeTestSecretKey : env.stripeLiveSecretKey));
}

function isStripeTestKey(value: string) {
  return /^(sk|rk)_test_/.test(value);
}

function normalizedAllowedDomains() {
  return new Set(env.developmentEmailAllowedDomains.map((domain) => clean(domain).toLowerCase()).filter(Boolean));
}

function normalizedAllowedPhones() {
  return new Set(env.developmentSmsAllowedE164.map((phone) => clean(phone)).filter(Boolean));
}

export function isExplicitDevelopmentCluster() {
  return env.dataEnvironmentExplicit
    && env.dataEnvironment === "development"
    && env.deploymentTopology === "cluster";
}

export function guardDevelopmentEmail(input: EmailGuardInput) {
  const recipients = Array.from(new Set(input.recipients.map(normalizeEmail).filter(Boolean)));
  if (!isExplicitDevelopmentCluster()) {
    counters.email_allowed += 1;
    return { allowed: true, recipients, subject: input.subject, rewritten: false, original_recipients: recipients } as const;
  }

  const allowedDomains = normalizedAllowedDomains();
  const allAllowed = recipients.length > 0 && recipients.every((recipient) => allowedDomains.has(emailDomain(recipient)));
  if (allAllowed) {
    counters.email_allowed += 1;
    return { allowed: true, recipients, subject: input.subject, rewritten: false, original_recipients: recipients } as const;
  }

  if (env.developmentEmailMode === "rewrite" && env.developmentEmailCatchall) {
    counters.email_rewritten += 1;
    return {
      allowed: true,
      recipients: [env.developmentEmailCatchall],
      subject: `[DEV intended for ${recipients.join(", ") || "missing recipient"}] ${input.subject}`,
      rewritten: true,
      original_recipients: recipients
    } as const;
  }

  counters.email_blocked += 1;
  return {
    allowed: false,
    recipients: [],
    subject: input.subject,
    rewritten: false,
    original_recipients: recipients,
    reason: "development_email_recipient_blocked"
  } as const;
}

export function guardDevelopmentSms(phone: string) {
  const normalized = clean(phone);
  if (!isExplicitDevelopmentCluster()) {
    counters.sms_allowed += 1;
    return { allowed: true, phone: normalized } as const;
  }
  if (env.developmentSmsMode === "allowlist" && normalizedAllowedPhones().has(normalized)) {
    counters.sms_allowed += 1;
    return { allowed: true, phone: normalized } as const;
  }
  counters.sms_blocked += 1;
  return { allowed: false, phone: normalized, reason: "development_sms_recipient_blocked" } as const;
}

export function inspectEnvironmentSafety() {
  const development = isExplicitDevelopmentCluster();
  const stripeKey = configuredStripeKey();
  const allowedDomains = [...normalizedAllowedDomains()];
  const emailCatchallDomain = emailDomain(env.developmentEmailCatchall);
  const checks = {
    isolated_session_cookie: !development || env.platformSessionCookieName !== "fm_platform_session",
    isolated_artifact_writes: !development || !env.spacesReadFallbackPrefix || env.spacesReadFallbackPrefix !== env.spacesPrefix,
    read_fallback_development_only: !env.spacesReadFallbackPrefix || development,
    stripe_test_mode: !development || env.stripeTestMode,
    stripe_test_credentials: !development || (!stripeKey || isStripeTestKey(stripeKey)),
    stripe_live_credentials_absent: !development || !clean(env.stripeLiveSecretKey),
    stripe_development_return_url: !development || !/\bapp\.1m8\.ai\b/i.test(env.stripeBaseUrl),
    email_policy: !development || ["block", "rewrite"].includes(env.developmentEmailMode),
    email_allowlist: !development || allowedDomains.length > 0,
    email_catchall: !development || env.developmentEmailMode !== "rewrite"
      || Boolean(env.developmentEmailCatchall && allowedDomains.includes(emailCatchallDomain)),
    sms_policy: !development || ["block", "allowlist"].includes(env.developmentSmsMode),
    sms_allowlist: !development || env.developmentSmsMode !== "allowlist" || normalizedAllowedPhones().size > 0,
    worker_authorized: !development || env.clusterNodeRole !== "worker"
      || Number(env.firstmeasureJobWorkers ?? 0) === 0 || env.developmentWorkerEnabled
  };
  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: failures.length === 0,
    enforced: development,
    environment: env.dataEnvironment,
    checks,
    failures,
    email: {
      mode: development ? env.developmentEmailMode : "production-routing",
      allowed_domains: allowedDomains,
      catchall_configured: Boolean(env.developmentEmailCatchall),
      counters: {
        allowed: counters.email_allowed,
        rewritten: counters.email_rewritten,
        blocked: counters.email_blocked
      }
    },
    sms: {
      mode: development ? env.developmentSmsMode : "production-routing",
      allowed_number_count: normalizedAllowedPhones().size,
      counters: { allowed: counters.sms_allowed, blocked: counters.sms_blocked }
    },
    stripe: {
      mode: env.stripeTestMode ? "test" : "live",
      credential_configured: Boolean(stripeKey),
      credential_is_test: Boolean(stripeKey && isStripeTestKey(stripeKey))
    },
    artifacts: {
      write_prefix: env.spacesPrefix,
      read_fallback_prefix: env.spacesReadFallbackPrefix || null,
      overlay_enabled: Boolean(env.spacesReadFallbackPrefix)
    },
    worker: {
      role: env.clusterNodeRole,
      configured_workers: Number(env.firstmeasureJobWorkers ?? 0),
      development_authorized: env.developmentWorkerEnabled
    }
  } as const;
}

export function assertRuntimeEnvironmentSafety() {
  const report = inspectEnvironmentSafety();
  if (!report.ok) {
    throw new Error(`Unsafe development environment configuration: ${report.failures.join(", ")}.`);
  }
  return report;
}
