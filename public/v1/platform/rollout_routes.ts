/** Server-side release boundary for the platform-only HTTP surfaces.
 * Public links/provider callbacks keep their own token/org validation. */
const platformApis = new Set([
  "audio-notes", "agents", "appointments", "assistant", "calls", "channels", "chat", "comms",
  "connections", "documents", "document-modules", "publication", "domains", "equipment", "feedback", "financials", "messaging",
  "payroll", "scopes", "signup-sandbox", "stats", "training", "websites", "work", "workforce"
]);
const coreCollections = new Set(["users", "projects", "customers", "branch", "notifications", "action_items", "activity"]);
export function routeNeedsExpandedPlatform(route: string, params: unknown) {
  const parts = route.split("/").filter(Boolean);
  if (parts[0] !== "v1") return false;
  if (platformApis.has(parts[1] || "")) return true;
  if (parts[1] === "internal" && /\/call-(lists|list-entries)(\/|$)/.test(route)) return true;
  if (parts[1] !== "platform") return false;
  const input = params && typeof params === "object" ? params as Record<string, unknown> : {};
  if (route.includes(":collection") && !coreCollections.has(String(input.collection || ""))) return true;
  return /\/(recurrence-series|punch-lists|terminology-agent)(\/|$)/.test(route)
    || /\/(events\/(poll|stream)|pricebook\/generate|customer-portal\/shares|routing)(\/|$)/.test(route);
}
