// IANA tzdb 2026d, retrieved 2026-09-25. Public-domain source:
// https://data.iana.org/time-zones/tzdb/zone.tab and backward.
// zone.tab retains one country per zone (including country-specific aliases).
// Shared with the unauthenticated login billboard; keep one country/zone source.
import regionData from "./region-data.json" with { type: "json" };
export const TIME_ZONE_COUNTRIES: Readonly<Record<string, string>> = regionData.time_zone_countries;
