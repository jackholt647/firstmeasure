import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { groupedCapabilityValuesErrors, groupedCapabilityValuesSchema } from "./capability_values.js";

/**
 * The operator's app flag defaults for new organizations (docs/architecture/config-library.md): flag values, in the
 * stored `{group: {flag: value}}` shape, laid over what the signup preset gives a newly registered organization
 * (platform/app_flags.ts newOrganizationAppFlagDefaults). The internal console writes it through
 * PUT /v1/internal/admin/app-flag-defaults. Empty, the signup preset alone decides. The signup preset's own fixed
 * values (the FirstMeasure-only start) are applied last either way.
 */
export const APP_FLAG_DEFAULTS_KIND = "app_flag_defaults";
export const APP_FLAG_DEFAULTS_ID = "new_organization";

export type AppFlagDefaultsData = { app_flags: Record<string, Record<string, boolean | number | string>> };

export const appFlagDefaultsKind: LibraryKind<AppFlagDefaultsData> = {
  kind: APP_FLAG_DEFAULTS_KIND,
  title: "App flag defaults",
  description: "App flags every newly registered organization starts with, over the signup preset.",
  idPattern: /^new_organization$/,
  schema: z.object({ app_flags: groupedCapabilityValuesSchema }).strict(),
  validate: (data, ctx) => [
    ...(ctx.id === APP_FLAG_DEFAULTS_ID ? [] : [`There is one app flag defaults entry, ${APP_FLAG_DEFAULTS_ID}.`]),
    ...groupedCapabilityValuesErrors(data.app_flags, "app_flags")
  ],
  titleOf: () => "New organization app flags"
};
