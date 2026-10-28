import type { Generator } from "./index.js";
import { APP_FLAG_DEFAULTS_ID, APP_FLAG_DEFAULTS_KIND } from "../kinds/app_flag_defaults.js";

/**
 * The code holds no operator flag defaults: with none saved, the signup preset alone decides
 * (newOrganizationAppFlagDefaults). The ones an operator saved on a host are imported from that host's platform
 * configuration the first time the library is read there.
 */
export const appFlagDefaultsGenerator: Generator = {
  kind: APP_FLAG_DEFAULTS_KIND,
  run: () => [{ id: APP_FLAG_DEFAULTS_ID, data: { app_flags: {} } }]
};
