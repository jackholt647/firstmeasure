// The one normalizer for contact points. Matching, intake, import and comms all
// compare these values, so a change here changes who counts as the same person.

export type ContactPointKind = "email" | "phone" | "address";

const text = (value: unknown) => String(value ?? "").trim();

export function normalizeEmail(value: unknown) {
  const email = text(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

/** E.164. Ten digits and eleven digits starting with 1 are read as North American numbers. */
export function normalizePhone(value: unknown) {
  const raw = text(value);
  const compact = raw.replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

export function normalizeAddress(value: unknown) {
  return text(value).toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizePoint(kind: ContactPointKind, value: unknown) {
  return kind === "email" ? normalizeEmail(value) : kind === "phone" ? normalizePhone(value) : normalizeAddress(value);
}

/** Folded name used only to score near matches. */
export function nameKey(value: unknown) {
  return text(value).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
