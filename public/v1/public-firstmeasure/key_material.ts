import path from "node:path";

import { env } from "../src/config/env.js";

export function publicFirstMeasureApiKeySecret() {
  return process.env.PUBLIC_FIRSTMEASURE_API_KEY_SECRET
    || process.env.FIRSTMEASURE_PUBLIC_API_KEY_SECRET
    || env.platformSessionSecret;
}

export function publicFirstMeasureKeyRoot() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "api_keys", "firstmeasure");
}

