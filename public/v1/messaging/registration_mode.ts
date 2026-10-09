import { env } from "../src/config/env.js";

export function smsRegistrationIsLive(organizationId: string) {
  return env.communicationsDeliveryMode === "live"
    || (env.dataEnvironment === "development" && env.smsLiveRegistrationOrganizationIds.includes(organizationId));
}

export function hasLiveSmsRegistration() {
  return env.communicationsDeliveryMode === "live"
    || (env.dataEnvironment === "development" && env.smsLiveRegistrationOrganizationIds.length > 0);
}
