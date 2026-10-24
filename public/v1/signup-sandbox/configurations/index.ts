// Sandbox configurations that carry their own code. Each is a workflow seed
// (seeded once, then edited as data) plus setup scripts that run when a test
// organization is created from a workflow naming them in `setup_scripts`.
// Nothing outside this folder checks which configuration an organization uses.
import type { JsonObject } from "../storage.js";
import * as mvpPlatform from "./mvp-platform.js";

export type SandboxConfiguration = {
  workflow: JsonObject;
  defaults: () => JsonObject;
};

export const CONFIGURATIONS: SandboxConfiguration[] = [
  { workflow: mvpPlatform.workflow, defaults: mvpPlatform.defaults }
];

export const SETUP_SCRIPTS: Record<string, (orgId: string) => Promise<void>> = {
  "mvp-platform": (orgId) => mvpPlatform.setup(orgId)
};
