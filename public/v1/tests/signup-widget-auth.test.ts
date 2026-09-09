import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const widgetSource = readFileSync(new URL("../../portal/landing/shared/signup-widget.js", import.meta.url), "utf8");
const googleSource = readFileSync(new URL("../../libraries/google-auth/firstmate-google-auth.js", import.meta.url), "utf8");

test("landing signup presents backend auth errors as actionable messages", () => {
  const start = widgetSource.indexOf("    function authErrorMessage(");
  const end = widgetSource.indexOf("    function loginErrorMessage(", start);
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({});
  vm.runInContext(widgetSource.slice(start, end), context);
  const message = context.authErrorMessage as (data: unknown, fallback?: string) => string;

  assert.match(message({ error: "identity_phone_exists" }), /phone number is already connected/);
  assert.match(message({ error: "identity_email_exists" }), /email address.*existing account/);
  assert.match(message({ error: "Invalid or expired code." }), /Request a new code/);
  assert.match(message({ status_code: 429 }), /Too many attempts/);
  assert.doesNotMatch(message({ error: "private_database_error" }), /private_database_error/);
  assert.doesNotMatch(widgetSource, /show(?:Register)?Notice\(data\.error/);
});

test("Google button waits for a visible container and follows its actual width", async () => {
  let width = 0;
  let resizeCallback: (() => void) | undefined;
  const renderedWidths: number[] = [];
  let clears = 0;
  const container = {
    isConnected: true,
    clientWidth: 0,
    addEventListener() {},
    getBoundingClientRect: () => ({ width, height: width ? 44 : 0 }),
    replaceChildren: () => { clears += 1; }
  };
  class ResizeObserver {
    constructor(callback: () => void) { resizeCallback = callback; }
    observe() {}
  }
  const window = {
    ResizeObserver,
    requestAnimationFrame: (callback: () => void) => callback(),
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    google: {
      accounts: {
        id: {
          initialize() {},
          renderButton(_container: unknown, options: { width: number }) { renderedWidths.push(options.width); }
        }
      }
    }
  };
  const context = vm.createContext({
    window,
    document: { querySelector: () => null, documentElement: {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, client_id: "test-client" }) })
  });
  vm.runInContext(googleSource, context);
  await (window as typeof window & { FirstMateGoogleAuth: { mountButton(options: unknown): Promise<unknown> } }).FirstMateGoogleAuth.mountButton({
    container,
    apiBaseUrl: "/v1/platform",
    text: "signup_with"
  });

  assert.deepEqual(renderedWidths, []);
  width = 286;
  resizeCallback?.();
  assert.deepEqual(renderedWidths, [286]);
  assert.equal(clears, 1);
  resizeCallback?.();
  assert.deepEqual(renderedWidths, [286]);
  width = 320;
  resizeCallback?.();
  assert.deepEqual(renderedWidths, [286, 320]);
  width = 560;
  resizeCallback?.();
  assert.deepEqual(renderedWidths, [286, 320, 400]);
});
