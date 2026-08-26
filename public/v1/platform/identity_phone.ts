/** Normalize North American local numbers or international numbers to E.164. */
export function normalizeIdentityPhone(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D+/g, "");
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

/** Render North American identity phones consistently while preserving E.164 for other countries. */
export function formatIdentityPhone(value: unknown) {
  const normalized = normalizeIdentityPhone(value);
  if (!normalized) return "";
  const northAmerican = normalized.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return northAmerican
    ? `(${northAmerican[1]}) ${northAmerican[2]}-${northAmerican[3]}`
    : normalized;
}

/** Signup currently collects a ten-digit US/Canada mobile number. */
export function formatSignupPhone(value: unknown) {
  const normalized = normalizeIdentityPhone(value);
  return /^\+1\d{10}$/.test(normalized) ? formatIdentityPhone(normalized) : "";
}

export function identifierLooksLikeEmail(value: unknown) {
  return String(value ?? "").trim().includes("@");
}
