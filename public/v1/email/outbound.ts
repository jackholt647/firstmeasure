import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardDevelopmentEmail } from "../src/environment_safety.js";

export type TransactionalEmailInput = {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  from?: string;
  replyTo?: string;
  tag?: string;
  metadata?: Record<string, string>;
};

const API_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEmail(value: unknown) {
  const email = cleanText(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

export function escapeEmailHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapEmailText(text: string) {
  const body = cleanText(text);
  if (!body) return "";
  if (body.includes("\n--\nThe FirstMate Team")) return body;
  return `${body}\n\n--\nThe FirstMate Team\n1m8.ai`;
}

function wrapEmailHtml(html: string) {
  const body = cleanText(html);
  if (!body) return "";
  if (body.includes("The FirstMate Team")) return body;
  return `${body}<hr><div style="font-size:12px;color:#777;">The FirstMate Team<br><a href="https://1m8.ai">1m8.ai</a></div>`;
}

async function readPostmarkToken() {
  for (const key of ["POSTMARK_SERVER_TOKEN", "POSTMARK_API_TOKEN", "FIRSTMEASURE_POSTMARK_TOKEN"]) {
    const token = cleanText(process.env[key]);
    if (token) return token;
  }

  const candidates = [
    path.resolve(process.cwd(), "./storage/secrets/pm_server_token.txt"),
    path.resolve(process.cwd(), "./pm_server_token.txt"),
    path.resolve(API_MODULE_DIR, "../../storage/secrets/pm_server_token.txt"),
    path.resolve(API_MODULE_DIR, "../pm_server_token.txt")
  ];

  for (const filePath of candidates) {
    try {
      const token = (await readFile(filePath, "utf8")).trim();
      if (token) return token;
    } catch {
      continue;
    }
  }
  return "";
}

export async function sendTransactionalEmail(input: TransactionalEmailInput) {
  const to = normalizeEmail(input.to);
  const subject = cleanText(input.subject);
  const textBody = cleanText(input.textBody);
  if (!to) return { ok: false, success: false, error: "missing_recipient" };
  if (!subject) return { ok: false, success: false, error: "missing_subject" };
  if (!textBody && !cleanText(input.htmlBody)) return { ok: false, success: false, error: "missing_body" };
  if (process.env.EMAIL_OUTBOUND_DISABLED === "1" || process.env.EMAIL_OUTBOUND_DISABLED === "true") {
    return { ok: false, success: false, skipped: true, reason: "email_outbound_disabled" };
  }

  const guarded = guardDevelopmentEmail({ recipients: [to], subject });
  if (!guarded.allowed) {
    return { ok: false, success: false, skipped: true, reason: guarded.reason };
  }

  const token = await readPostmarkToken();
  if (!token) return { ok: false, success: false, error: "postmark_token_missing" };

  const fallbackHtml = `<div>${escapeEmailHtml(textBody).replace(/\n/g, "<br>")}</div>`;
  const payload = {
    From: cleanText(input.from) || "noreply@1m8.ai",
    To: guarded.recipients[0],
    Subject: guarded.subject,
    TextBody: wrapEmailText(textBody),
    HtmlBody: wrapEmailHtml(input.htmlBody || fallbackHtml),
    ReplyTo: cleanText(input.replyTo) || "support@1m8.ai",
    ...(cleanText(input.tag) ? { Tag: cleanText(input.tag) } : {}),
    ...((input.metadata && Object.keys(input.metadata).length) || guarded.rewritten ? {
      Metadata: {
        ...(input.metadata ?? {}),
        ...(guarded.rewritten ? { development_intended_recipient: guarded.original_recipients.join(",") } : {})
      }
    } : {})
  };

  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token
    },
    body: JSON.stringify(payload)
  });

  let postmark: Record<string, unknown> | null = null;
  try {
    postmark = await response.json() as Record<string, unknown>;
  } catch {
    postmark = null;
  }

  return {
    ok: response.ok,
    success: response.ok,
    http: response.status,
    postmark
  };
}
