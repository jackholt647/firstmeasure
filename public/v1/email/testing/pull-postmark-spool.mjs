#!/usr/bin/env node
/**
 * TEST-ONLY helper.
 *
 * Pulls captured Postmark payloads from the public PHP test inbox and replays them
 * into the local V1 Email API. This is intentionally outside the production API
 * route tree.
 *
 * Required:
 *   POSTMARK_SPOOL_KEY=...
 *
 * Optional:
 *   POSTMARK_SPOOL_URL=https://app.1m8.ai/v1/email/inbound/postmark/index.php
 *   LOCAL_EMAIL_WEBHOOK_URL=http://127.0.0.1:3111/v1/email/inbound/postmark
 *   EMAIL_INBOUND_WEBHOOK_TOKEN=...
 */

import http from "node:http";
import https from "node:https";
import dns from "node:dns";

const spoolUrl = process.env.POSTMARK_SPOOL_URL || "https://app.1m8.ai/v1/email/inbound/postmark/index.php";
const spoolKey = process.env.POSTMARK_SPOOL_KEY || "";
const localWebhookUrl = process.env.LOCAL_EMAIL_WEBHOOK_URL || "http://127.0.0.1:3111/v1/email/inbound/postmark";
const localWebhookToken = process.env.EMAIL_INBOUND_WEBHOOK_TOKEN || "";

if (!spoolKey) {
  console.error("POSTMARK_SPOOL_KEY is required.");
  process.exit(1);
}

function requestText(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "http:" ? http : https;
    const body = options.body || null;
    const request = transport.request(target, {
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: Number(options.timeout || 60000),
      lookup(hostname, lookupOptions, callback) {
        dns.lookup(hostname, { ...lookupOptions, family: 4 }, callback);
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          text: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Request timed out after ${options.timeout || 60000}ms`)));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function requestJson(url, options = {}) {
  const response = await requestText(url, options);
  const text = response.text;
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok || data?.ok === false) {
    throw new Error(`${options.method || "GET"} ${url} failed: ${response.status} ${text}`);
  }
  return data;
}

const downloadUrl = new URL(spoolUrl);
downloadUrl.searchParams.set("action", "download");
downloadUrl.searchParams.set("key", spoolKey);

const download = await requestJson(downloadUrl.toString());
const messages = Array.isArray(download.messages) ? download.messages : [];
console.log(`Downloaded ${messages.length} queued Postmark message(s).`);

const acked = [];
for (const message of messages) {
  const id = String(message.id || "");
  const body = typeof message.body === "string" && message.body
    ? message.body
    : JSON.stringify(message.json || {});
  const headers = {
    "Accept": "application/json",
    "Content-Type": String(message.content_type || "application/json")
  };
  if (localWebhookToken) headers["X-Email-Webhook-Token"] = localWebhookToken;

  const response = await fetch(localWebhookUrl, {
    method: "POST",
    headers,
    body
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`Replay failed for ${id || "(no id)"}: ${response.status} ${text}`);
    continue;
  }
  console.log(`Replayed ${id}: ${text.slice(0, 240)}`);
  if (id) acked.push(id);
}

if (acked.length) {
  const ack = await requestJson(spoolUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ action: "ack", key: spoolKey, ids: acked })
  });
  console.log(`Acked ${Array.isArray(ack.acked) ? ack.acked.length : 0} message(s).`);
}
