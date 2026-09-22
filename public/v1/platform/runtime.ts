import { env } from "../src/config/env.js";

/** HTTP replicas never own platform schedulers in the clustered deployment. */
export function platformBackgroundAllowed() {
  if (env.isTest || process.env.PLATFORM_BACKGROUND_DISABLED === "1") return false;
  return env.deploymentTopology === "single" || process.env.PLATFORM_PROCESS_ROLE === "worker";
}
