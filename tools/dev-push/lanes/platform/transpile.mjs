// public/v1/dist without a type check (docs/architecture/dev-lanes.md): every TypeScript file is transpiled on its own
// (ts.transpileModule, ES2022 modules, as dev has always shipped) and cached by content, so a release only transpiles
// what changed and links the rest; JSON the server imports is copied beside it, as tsc does. The type check itself is
// an opt-in regression gate (`submit.mjs --regression`).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const SKIP_DIRS = new Set(["node_modules", "dist", ".tmp", "storage", "output", ".git"]);
const SKIP_JSON = new Set(["package.json", "package-lock.json", "tsconfig.json"]);

function* sources(v1, rel = "") {
  for (const entry of fs.readdirSync(path.join(v1, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && child !== "firstmeasure/dist") yield* sources(v1, child); continue; }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) yield { rel: child, kind: "ts" };
    else if (entry.name.endsWith(".json") && !SKIP_JSON.has(entry.name) && !/^tsconfig\..*\.json$/.test(entry.name)) yield { rel: child, kind: "json" };
  }
}

/** Transpiles one source; { ok, output } or { ok: false, errors }. */
export function transpileSource(ts, text, fileName) {
  const result = ts.transpileModule(text, { fileName, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  const errors = (result.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error)
    .map((item) => `${fileName}${item.file && item.start !== undefined ? `:${item.file.getLineAndCharacterOfPosition(item.start).line + 1}` : ""}: ${ts.flattenDiagnosticMessageText(item.messageText, "\n")}`);
  return errors.length ? { ok: false, errors } : { ok: true, output: result.outputText };
}

/** Builds `out` (a fresh directory) from the sources under `v1`; cached outputs are hard-linked. */
export function buildDist(v1, out, cacheDir) {
  const ts = createRequire(path.join(v1, "package.json"))("typescript");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.rmSync(out, { recursive: true, force: true });
  const errors = [];
  let transpiled = 0, files = 0;
  for (const { rel, kind } of sources(v1)) {
    const text = fs.readFileSync(path.join(v1, rel));
    const target = path.join(out, kind === "ts" ? `${rel.slice(0, -3)}.js` : rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    files++;
    if (kind === "json") { fs.copyFileSync(path.join(v1, rel), target); continue; }
    const key = crypto.createHash("sha1").update(`${ts.version}\0${rel}\0`).update(text).digest("hex");
    const cached = path.join(cacheDir, key.slice(0, 2), `${key}.js`);
    if (!fs.existsSync(cached)) {
      const result = transpileSource(ts, text.toString("utf8"), rel);
      if (!result.ok) { errors.push(...result.errors); continue; }
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      fs.writeFileSync(`${cached}.tmp`, result.output);
      fs.renameSync(`${cached}.tmp`, cached);
      transpiled++;
    }
    fs.linkSync(cached, target);
  }
  return { ok: errors.length === 0, errors, files, transpiled };
}
