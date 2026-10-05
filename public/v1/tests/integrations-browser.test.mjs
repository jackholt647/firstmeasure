import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

test("Connections settings: accessible setup, shared assistant, private credentials, grants, mobile layout", async () => {
  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  try {
    const page = await browser.newPage({
        viewport: { width: 1360, height: 1000 },
      }),
      errors = [],
      submissions = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const connection = {
      id: "conn_demo",
      name: "Field photos",
      description: "Projects and photos from your field team.",
      enabled: true,
      activeVersion: "v1",
      draftVersion: "v1",
      revision: 1,
      enabledOperations: ["read"],
      grants: {},
      owner: "owner",
    };
    const definition = {
      name: "Field photos",
      baseUrl: "https://photos.example",
      auth: { kind: "bearer" },
      credentialFields: [
        { key: "token", label: "API key", secret: true, required: true },
      ],
      operations: [
        {
          id: "read",
          title: "Read projects",
          description: "View projects and their photos.",
          effect: "read",
        },
        {
          id: "write",
          title: "Create project",
          description: "Create a project in the external account.",
          effect: "write",
        },
      ],
      resources: [
        {
          id: "projects",
          title: "Projects",
          description: "Synchronized field projects.",
          operation: "read",
          mode: "sync",
        },
      ],
    };
    await page.route("http://connections.test/**", async (route) => {
      const url = new URL(route.request().url()),
        p = url.pathname;
      if (p.startsWith("/libraries/"))
        return route.fulfill({
          contentType: "application/javascript",
          body: await readFile(
            new URL("../../libraries/" + p.slice(11), import.meta.url),
            "utf8",
          ),
        });
      if (p.startsWith("/v1/integrations/")) {
        const method = route.request().method();
        const payload =
          method === "POST" ? route.request().postDataJSON() : null;
        if (payload) submissions.push({ p, payload });
        let data = {};
        if (p.endsWith("/connections")) data = { connections: [connection] };
        else if (p.includes("/library"))
          data = { entries: [{ name: "CompanyCam", connector: null }] };
        else if (p.endsWith("/conversation"))
          data = {
            thread: { id: "connection-thread", subject_id: "connection:setup" },
          };
        else if (p.includes("/credential-requests/"))
          data =
            method === "POST"
              ? { saved: true }
              : {
                  request: {
                    id: "secure_request",
                    name: "Field photos",
                    destination: "https://photos.example",
                    fields: [
                      {
                        key: "token",
                        label: "API key",
                        secret: true,
                        required: true,
                      },
                    ],
                  },
                };
        else if (p.endsWith("/credentials"))
          data = { request: { id: "secure_request" } };
        else if (p.endsWith("/activate"))
          data = {
            connection: {
              ...connection,
              enabledOperations: payload.operations,
            },
          };
        else
          data = {
            connection,
            definition,
            automations: [],
            uses: [],
            resources: [],
            runs: [],
            summary: null,
          };
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      }
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:30px;font:14px system-ui;background:#f8fafc}main{max-width:1250px;margin:auto}</style><main class="main"><section id="settings"></section></main>',
      });
    });
    await page.goto("http://connections.test");
    await page.evaluate(() => {
      window.__APP = { userOrgId: "org" };
      window.Portal = {};
      window.AssistantAPI = {
        thread: async () => ({
          thread: { id: "connection-thread", subject_id: "connection:setup" },
          messages: [
            {
              id: "message",
              role: "assistant",
              content: "Enter your API key in the secure form below.",
              data: {
                renders: [
                  {
                    type: "connection_credentials",
                    requestId: "secure_request",
                  },
                ],
              },
            },
          ],
        }),
      };
    });
    for (const name of [
      "window-manager/window-manager.js",
      "platform-assistant/platform-assistant.js",
      "apps/settings/connections.js",
    ])
      await page.addScriptTag({ url: "/libraries/" + name });
    await page.evaluate(() =>
      FirstMateConnections.mount(document.querySelector("#settings"), {
        orgId: "org",
      }),
    );
    await page.getByRole("button", { name: /Field photos/ }).click();
    await page.getByRole("tab", { name: "Access", exact: true }).click();
    assert.equal(await page.locator("[data-operation=read]").isChecked(), true);
    assert.equal(
      await page.locator("[data-operation=write]").isChecked(),
      false,
    );
    await page.getByRole("button", { name: "Save access & enable" }).click();
    assert.deepEqual(
      submissions.find((s) => s.p.endsWith("/activate")).payload.operations,
      ["read"],
    );
    await page.getByRole("tab", { name: "Setup", exact: true }).click();
    await page
      .getByRole("button", { name: "Enter or replace credentials" })
      .click();
    const key = page.getByLabel("API key", { exact: true });
    await key.fill("browser-only-private-token");
    assert.equal(await key.getAttribute("type"), "password");
    await page
      .getByRole("button", { name: "Save credentials securely" })
      .click();
    await page
      .getByText("Credentials saved securely.", { exact: false })
      .waitFor();
    assert.equal(await key.count(), 0);
    assert.ok(
      !(await page
        .locator("body")
        .innerText()
        .then((text) => text.includes("browser-only-private-token"))),
    );
    assert.equal(
      submissions.filter((s) =>
        JSON.stringify(s.payload).includes("browser-only-private-token"),
      ).length,
      1,
    );
    await page
      .getByRole("button", { name: "Ask assistant", exact: true })
      .click();
    await page.locator(".ic-chat .fma-drawer").waitFor();
    await page
      .locator(".ic-chat")
      .getByLabel("API key", { exact: true })
      .waitFor();
    assert.equal(await page.locator(".ic-chat [data-fma=input]").count(), 1);
    const dir = new URL(
      "../../../output/integrations-verification/",
      import.meta.url,
    );
    await mkdir(dir, { recursive: true });
    await page.screenshot({
      path: new URL("connections-desktop.png", dir).pathname.replace(
        /^\/(\w:)/,
        "$1",
      ),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: new URL("connections-mobile.png", dir).pathname.replace(
        /^\/(\w:)/,
        "$1",
      ),
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "mobile page should not scroll horizontally",
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
