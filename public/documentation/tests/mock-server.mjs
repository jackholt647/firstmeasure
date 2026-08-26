import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.DOCS_TEST_PORT || 4177);
const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const reports = new Map();
const idempotency = new Map();

const json = (response, status, body) => {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": bytes.length });
  response.end(bytes);
};

const report = (id) => ({
  id,
  external_id: "docs-browser-test",
  mode: "test",
  test_mode: true,
  status: "completed",
  address: "1600 Amphitheatre Parkway, Mountain View, CA 94043",
  project_type: "residential",
  amount_charged: 0,
  quoted_amount: 7,
  created_at: "2026-08-25T19:00:00.000Z",
  updated_at: "2026-08-25T19:00:00.000Z",
  completed_at: "2026-08-25T19:00:00.000Z",
  artifacts: { has_report_pdf: true, has_summary_pdf: true, has_model_data: true, has_pdf_state: false },
  links: {
    self: `/v1/public/firstmeasure/reports/${id}`,
    pdf: `/v1/public/firstmeasure/reports/${id}/pdf`,
    measurements: `/v1/public/firstmeasure/reports/${id}/measurements`
  },
  rejection: null,
  metadata: { source: "documentation_browser_test" }
});

async function requestBody(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  const text = Buffer.concat(parts).toString("utf8");
  return text ? JSON.parse(text) : null;
}

function apiRequest(request, response, url) {
  if (url.pathname === "/v1/public/firstmeasure/") return json(response, 200, { ok: true, api: "public_firstmeasure", version: "test" });
  const authorization = request.headers.authorization || "";
  if (!authorization.startsWith("Bearer fmk_test_")) return json(response, 401, { ok: false, error: "invalid_api_key" });

  if (url.pathname.endsWith("/pricing")) return json(response, 200, { ok: true, mode: "test", test_mode: true, project_type: "residential", structure_count: 1, options: [{ key: "standard_3_6", price: 7 }] });
  if (url.pathname.endsWith("/balance")) return json(response, 200, { ok: true, mode: "test", test_mode: true, balance: 100, message: "Test requests do not charge credits." });

  if (url.pathname.endsWith("/reports") && request.method === "POST") {
    return requestBody(request).then((body) => {
      const key = String(request.headers["idempotency-key"] || "");
      if (!key) return json(response, 400, { ok: false, error: "missing_idempotency_key" });
      if (idempotency.has(key)) return json(response, 200, { ok: true, mode: "test", test_mode: true, idempotent_replay: true, report: idempotency.get(key) });
      const created = report("fmr_browser_test_001");
      created.external_id = body?.external_id || created.external_id;
      reports.set(created.id, created);
      idempotency.set(key, created);
      return json(response, 201, { ok: true, mode: "test", test_mode: true, report: created, billing: { test_mode: true, amount_charged: 0, quoted_amount: 7 } });
    }).catch((error) => json(response, 400, { ok: false, error: "invalid_json", message: error.message }));
  }

  if (url.pathname.endsWith("/reports") && request.method === "GET") return json(response, 200, { ok: true, count: reports.size, reports: [...reports.values()] });

  const match = url.pathname.match(/^\/v1\/public\/firstmeasure\/reports\/([^/]+)(.*)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const suffix = match[2];
    const current = reports.get(id) || report(id);
    if (!suffix && request.method === "GET") return json(response, 200, { ok: true, mode: "test", test_mode: true, report: current, project: { id: "test_" + id, status: "completed" } });
    if (suffix === "/pdf" && request.method === "POST") return requestBody(request).then((input) => json(response, 200, { ok: true, mode: "test", test_mode: true, report_id: id, result: { ok: true, generated: false, input } }));
    if (suffix === "/pdf" && request.method === "GET") {
      const pdf = Buffer.from("%PDF-1.4\n% documentation browser test\n%%EOF\n");
      response.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${id}-test-report.pdf"`, "Content-Length": pdf.length });
      return response.end(pdf);
    }
    if (suffix === "/measurements" && url.searchParams.get("format") === "roofplan") {
      const xml = Buffer.from('<?xml version="1.0"?><ROOFPLAN><LOCATION address="Test"/><POINT id="P1" data="0,0,0"/></ROOFPLAN>');
      response.writeHead(200, { "Content-Type": "application/xml", "Content-Disposition": 'attachment; filename="model-data.xml"', "Content-Length": xml.length });
      return response.end(xml);
    }
    if (suffix === "/measurements") return json(response, 200, { ok: true, mode: "test", test_mode: true, report_id: id, measurements: { schema_version: 1, summary: { point_count: 4, face_count: 1, total_roof_area: 1800 } } });
    if (suffix === "/files") return json(response, 200, { ok: true, mode: "test", test_mode: true, report_id: id, files: [{ name: "model-data.xml", content_type: "application/xml", url: `/v1/public/firstmeasure/reports/${id}/files/model-data.xml` }] });
    if (suffix.startsWith("/files/")) {
      const file = Buffer.from("<ROOFPLAN/>");
      response.writeHead(200, { "Content-Type": "application/xml", "Content-Disposition": 'attachment; filename="model-data.xml"', "Content-Length": file.length });
      return response.end(file);
    }
  }

  if (url.pathname.endsWith("/webhooks/test") && request.method === "POST") {
    return requestBody(request).then((body) => json(response, 200, { ok: true, received_at: new Date().toISOString(), body }));
  }
  return json(response, 404, { ok: false, error: "not_found" });
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".xml": "application/xml", ".png": "image/png", ".ttf": "font/ttf" };

createServer(async (request, response) => {
  const url = new URL(request.url, "http://docs.test");
  if (url.pathname.startsWith("/v1/public/firstmeasure")) return apiRequest(request, response, url);

  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const target = path.resolve(publicRoot, relative);
  if (!target.startsWith(publicRoot + path.sep)) return json(response, 403, { ok: false });
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return json(response, 404, { ok: false, error: "not_found" });
  const body = await readFile(target);
  response.writeHead(200, { "Content-Type": mime[path.extname(target)] || "application/octet-stream", "Content-Length": body.length });
  response.end(body);
}).listen(port, "0.0.0.0", () => {
  console.log(`documentation sandbox server ready on port ${port}`);
});

