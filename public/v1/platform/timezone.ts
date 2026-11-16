// Shared timezone resolution + wall-clock math. An organization's local
// timezone comes from (in order): the branch scheduling module's
// availability.timezone, the organization/global record's timezone, then the
// server's own zone — so every feature that promises "the company's local
// time" (appointment confirmations, agent wakeups) agrees on what that means.
// An organization nobody gave a zone to uses the zone of the person's device
// (when the request carries one) before the server's zone, and adopts it on its
// first booking (FM-504: a dev server in UTC turned a 1 PM booking into 5 AM).

import { patchOrganization, readBranchModule, readGlobal, readOrganization } from "./storage.js";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The value when it names a real IANA zone, otherwise the fallback. */
export function safeTimezone(value: unknown, fallback: string) {
  const timezone = text(value);
  if (!timezone || timezone.toLowerCase() === "local") return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return fallback;
  }
}

export function systemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock fields of an instant in a given zone. Formatters are cached; building one is costly. */
export function zonedParts(instant: Date, timezone: string) {
  let formatter = zonedFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    if (zonedFormatters.size < 500) zonedFormatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: parts.year || 1970,
    month: parts.month || 1,
    day: parts.day || 1,
    hour: parts.hour || 0,
    minute: parts.minute || 0,
    second: parts.second || 0
  };
}

/** The instant at which the given wall-clock time occurs in a zone. */
export function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timezone: string) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetAt = (instant: number) => {
    const parts = zonedParts(new Date(instant), timezone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant;
  };
  let instant = desired - offsetAt(desired);
  instant = desired - offsetAt(instant);
  return new Date(instant);
}

/** The zone an organization has been given, or "" when nobody has set one. */
export async function configuredOrganizationTimezone(orgId: string, branchId: string) {
  const normalizedBranch = text(branchId) || "default";
  const scheduling = await readBranchModule(orgId, normalizedBranch, "scheduling").catch(() => null);
  const availability = record(record(record(scheduling?.data).availability));
  const timezone = safeTimezone(availability.timezone, "");
  if (timezone) return timezone;
  const [organization, global] = await Promise.all([
    readOrganization(orgId).catch(() => ({} as Record<string, unknown>)),
    readGlobal(orgId).catch(() => null)
  ]);
  return safeTimezone(record(organization).timezone || record(global?.data).timezone, "");
}

/** The organization's local IANA timezone (never empty): its own, else the caller's device zone, else the server's. */
export async function resolveOrganizationTimezone(orgId: string, branchId: string, deviceTimezone: unknown = "") {
  return (await configuredOrganizationTimezone(orgId, branchId)) || safeTimezone(deviceTimezone, "") || systemTimezone();
}

/** resolveOrganizationTimezone for a write: an organization without a zone keeps the device zone it was given from now on. */
export async function adoptOrganizationTimezone(orgId: string, branchId: string, deviceTimezone: unknown) {
  const configured = await configuredOrganizationTimezone(orgId, branchId);
  if (configured) return configured;
  const timezone = safeTimezone(deviceTimezone, "");
  if (!timezone) return systemTimezone();
  await patchOrganization(orgId, { timezone });
  return timezone;
}
