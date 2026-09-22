import { isAppFlagEnabled } from "../platform/app_flags.js";

export const MOBILE_BRIDGE_VERSION = 1;
export function storeLink(value: string | undefined, platform: "android" | "ios" | "testflight") {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = { android: "play.google.com", ios: "apps.apple.com", testflight: "testflight.apple.com" }[platform];
    return url.protocol === "https:" && url.hostname === host && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function developmentDownloadsAllowed(environment = process.env) {
  return ["development", "test"].includes(environment.FIRSTMEASURE_DATA_ENVIRONMENT || "")
    && environment.MOBILE_DEVELOPER_DOWNLOADS_ENABLED === "1";
}
export async function mobileConfiguration(orgId: string) {
  const developer = developmentDownloadsAllowed() && await isAppFlagEnabled(orgId, "mobile", "developer_downloads");
  return {
    bridge_version: MOBILE_BRIDGE_VERSION,
    minimum_bridge_version: 1,
    release_id: process.env.RELEASE_ID || "local",
    stores: {
      android: storeLink(process.env.MOBILE_ANDROID_STORE_URL, "android"),
      ios: storeLink(process.env.MOBILE_IOS_STORE_URL, "ios")
    },
    developer: developer ? {
      android: process.env.MOBILE_ANDROID_TEST_APK_PATH ? `/v1/mobile/organizations/${encodeURIComponent(orgId)}/downloads/android` : null,
      ios: storeLink(process.env.MOBILE_IOS_TESTFLIGHT_URL, "testflight"),
      version: process.env.MOBILE_TEST_BUILD_VERSION || "Development build"
    } : null
  };
}
