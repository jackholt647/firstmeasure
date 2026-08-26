import assert from "node:assert/strict";
import test from "node:test";

import { resolveAzureMapsProviderKey, resolveGoogleProviderKey } from "../src/config/provider_keys.js";

test("provider key purposes fall back to the shared key", () => {
  const config = { google: { shared_api_key: "shared" } };
  assert.equal(resolveGoogleProviderKey(config, "browser"), "shared");
  assert.equal(resolveGoogleProviderKey(config, "browser_customer"), "shared");
  assert.equal(resolveGoogleProviderKey(config, "browser_internal"), "shared");
  assert.equal(resolveGoogleProviderKey(config, "solar"), "shared");
  assert.equal(resolveGoogleProviderKey(config, "places"), "shared");
});

test("provider-specific keys override server and shared fallbacks", () => {
  const config = {
    google: {
      shared_api_key: "shared",
      server_api_key: "server",
      browser_api_key: "browser",
      customer_browser_api_key: "customer-browser",
      solar_api_key: "solar"
    }
  };
  assert.equal(resolveGoogleProviderKey(config, "browser"), "browser");
  assert.equal(resolveGoogleProviderKey(config, "browser_customer"), "customer-browser");
  assert.equal(resolveGoogleProviderKey(config, "browser_internal"), "browser");
  assert.equal(resolveGoogleProviderKey(config, "solar"), "solar");
  assert.equal(resolveGoogleProviderKey(config, "places"), "server");
  assert.equal(resolveGoogleProviderKey(config, "server"), "server");
});

test("Azure Maps key resolves from the provider-key file", () => {
  assert.equal(resolveAzureMapsProviderKey({ azure: { maps_subscription_key: " azure-key " } }), "azure-key");
  assert.equal(resolveAzureMapsProviderKey({}), "");
});
