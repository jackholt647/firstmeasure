/**
 * Characterization of every access gate as it stands before the main app /
 * field app split is removed. Nothing here asserts that a gate is right; it
 * records what each one is so that a later change shows as a diff in
 * `app-split-gates.snapshot.json`.
 *
 * Routes are taken from the running application, not from a list. The router
 * is observed while `buildApp` registers, so every route the server would
 * answer is here with the handler it would run. V8 reports where that handler
 * is in the source, and the TypeScript compiler then reads which
 * `requirePlatformAuth` options the handler (or a helper it calls) passes.
 * Published data exports and actions are read from the publication registries
 * after bootstrap, and tabs from the access catalog.
 *
 * To accept a deliberate change:
 *   UPDATE_APP_SPLIT_GATES=1 npx tsx --test tests/app-split-gates.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import inspector from "node:inspector";
import { createRequire, findSourceMap } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { closePlatformFixtureStores } from "./helpers/platform-fixture.js";

type Json = Record<string, any>;
type SeenRoute = { router: unknown; method: string; url: string; store: any };
type Location = { file: string; line: number; column: number };

const here = path.dirname(fileURLToPath(import.meta.url));
const v1Root = path.resolve(here, "..");
const snapshotPath = path.join(here, "app-split-gates.snapshot.json");
const HOOK_STAGES = ["onRequest", "preParsing", "preValidation", "preHandler"] as const;

let app: any = null;
let storageRoot = "";
const seen: SeenRoute[] = [];
let restoreRouter = () => {};

function observeRouter() {
  const require = createRequire(import.meta.url);
  const fastifyEntry = require.resolve("fastify");
  const Router = createRequire(fastifyEntry)("find-my-way");
  const original = Router.prototype.on;
  Router.prototype.on = function (this: unknown, method: unknown, url: unknown, ...rest: unknown[]) {
    const store = rest.length >= 3 ? rest[2] : rest[1];
    for (const item of Array.isArray(method) ? method : [method]) {
      seen.push({ router: this, method: String(item), url: String(url), store });
    }
    return original.call(this, method, url, ...rest);
  };
  restoreRouter = () => { Router.prototype.on = original; };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-app-split-gates-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  observeRouter();
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  restoreRouter();
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

// ---------------------------------------------------------------------------
// Where each registered function is in the source.

async function locateFunctions(functions: Function[]): Promise<Array<Location | null>> {
  const session = new inspector.Session();
  session.connect();
  const post = (method: string, params?: Json) => new Promise<any>((resolve, reject) => {
    (session as any).post(method, params, (error: Error | null, result: unknown) => error ? reject(error) : resolve(result));
  });
  const scripts = new Map<string, string>();
  session.on("Debugger.scriptParsed", (message: any) => { scripts.set(String(message.params.scriptId), String(message.params.url)); });
  const holder = "__appSplitGateFunctions";
  try {
    await post("Debugger.enable");
    (globalThis as any)[holder] = functions;
    const list = await post("Runtime.evaluate", { expression: `globalThis.${holder}`, objectGroup: holder });
    const items = await post("Runtime.getProperties", { objectId: list.result.objectId, ownProperties: true });
    const result: Array<Location | null> = functions.map(() => null);
    for (const item of items.result) {
      if (!/^\d+$/.test(item.name) || !item.value?.objectId) continue;
      let objectId = String(item.value.objectId);
      let location: any = null;
      // Fastify binds handlers and hooks to the instance; follow to the function that was written.
      for (let hops = 0; hops < 4 && !location; hops += 1) {
        const described = await post("Runtime.getProperties", { objectId, ownProperties: true });
        const internal: any[] = described.internalProperties || [];
        const target = internal.find(entry => entry.name === "[[TargetFunction]]")?.value?.objectId;
        if (target) { objectId = String(target); continue; }
        location = internal.find(entry => entry.name === "[[FunctionLocation]]")?.value?.value || null;
        break;
      }
      if (!location) continue;
      const url = scripts.get(String(location.scriptId)) || "";
      if (!url.startsWith("file:")) continue;
      const origin: any = findSourceMap(url)?.findOrigin(Number(location.lineNumber) + 1, Number(location.columnNumber) + 1);
      const mapped = origin && origin.fileName
        ? { file: String(origin.fileName), line: Number(origin.lineNumber), column: Number(origin.columnNumber) }
        : { file: url, line: Number(location.lineNumber) + 1, column: Number(location.columnNumber) + 1 };
      const file = mapped.file.startsWith("file:") ? fileURLToPath(mapped.file) : mapped.file;
      result[Number(item.name)] = { file: path.resolve(file), line: mapped.line, column: mapped.column };
    }
    await post("Runtime.releaseObjectGroup", { objectGroup: holder });
    return result;
  } finally {
    delete (globalThis as any)[holder];
    session.disconnect();
  }
}

// ---------------------------------------------------------------------------
// What a function requires, read from the source.

type Value =
  | { k: "const"; v: unknown }
  | { k: "object"; props: Map<string, Value>; open?: string }
  | { k: "array"; items: Value[] }
  | { k: "alt"; options: Value[] }
  | { k: "dynamic"; text: string };

type Finding = { gates: string[]; checks: string[]; readsApplicationAccess: boolean; publication: boolean };

const GATE = "requirePlatformAuth";
/** Checks made after (or instead of) the entrance gate; the argument at this index names what is checked. */
const CHECKS: Record<string, number> = {
  hasPermission: 1,
  hasResourcePermission: 1,
  canUseScopedPermission: 1,
  can: 1,
  requireCapability: 1,
  hasAppEntitlement: 1,
  authContextFromRequest: -1
};
const PUBLICATION_GATES = new Set(["authorizePublication", "authorizePublicationDiscovery"]);
const MAX_DEPTH = 8;

function slash(file: string) { return file.replace(/\\/g, "/"); }
function relative(file: string) { return slash(path.relative(v1Root, file)); }
function shortText(node: ts.Node) {
  const text = node.getText().replace(/\s+/g, " ");
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function createAnalyzer(files: string[]) {
  const configPath = path.join(v1Root, "tsconfig.json");
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, v1Root);
  const program = ts.createProgram({ rootNames: files, options: { ...config.options, noEmit: true } });
  const checker = program.getTypeChecker();
  const sourceByPath = new Map(program.getSourceFiles().map(source => [slash(path.resolve(source.fileName)).toLowerCase(), source]));
  const isAuthFile = (node: ts.Node) => slash(node.getSourceFile().fileName).endsWith("/platform/auth.ts");
  const isPublicationContextFile = (node: ts.Node) => slash(node.getSourceFile().fileName).endsWith("/platform/publication/context.ts");
  const inProject = (node: ts.Node) => {
    const source = node.getSourceFile();
    return !source.isDeclarationFile && !slash(source.fileName).includes("/node_modules/");
  };

  function unwrap(node: ts.Expression): ts.Expression {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)
      || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current) || ts.isAwaitExpression(current)) {
      current = current.expression;
    }
    return current;
  }

  function symbolOf(node: ts.Node) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol;
  }

  function functionOf(declaration: ts.Node | undefined, hops = 0): ts.FunctionLikeDeclaration | null {
    if (!declaration || hops > 4) return null;
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isFunctionExpression(declaration)
      || ts.isArrowFunction(declaration)) return declaration.body ? declaration : null;
    if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
      const initializer = unwrap(declaration.initializer);
      if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) return initializer;
      if (ts.isIdentifier(initializer)) return functionOf(symbolOf(initializer)?.valueDeclaration, hops + 1);
      return null;
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      return functionOf(checker.getShorthandAssignmentValueSymbol(declaration)?.valueDeclaration, hops + 1);
    }
    return null;
  }

  function callee(call: ts.CallExpression) {
    const expression = unwrap(call.expression);
    const symbol = symbolOf(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
    const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
    if (!symbol || !declaration) return null;
    return { name: symbol.getName(), declaration, fn: functionOf(declaration) };
  }

  // -- constant evaluation of the options a gate is given

  const dynamic = (node: ts.Node): Value => ({ k: "dynamic", text: shortText(node) });
  const constant = (v: unknown): Value => ({ k: "const", v });
  function alt(...options: Value[]): Value {
    const flat = options.flatMap(option => option.k === "alt" ? option.options : [option]);
    const unique = [...new Map(flat.map(option => [JSON.stringify(render(option)) ?? "undefined", option])).values()];
    return unique.length === 1 ? unique[0]! : { k: "alt", options: unique };
  }

  function evaluate(nodeValue: ts.Expression, env: Map<ts.Symbol, Value>, depth = 0): Value {
    const node = unwrap(nodeValue);
    if (depth > 12) return dynamic(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return constant(node.text);
    if (ts.isNumericLiteral(node)) return constant(Number(node.text));
    if (node.kind === ts.SyntaxKind.TrueKeyword) return constant(true);
    if (node.kind === ts.SyntaxKind.FalseKeyword) return constant(false);
    if (node.kind === ts.SyntaxKind.NullKeyword) return constant(null);
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined") return constant(undefined);
      const symbol = symbolOf(node);
      if (!symbol) return dynamic(node);
      const bound = env.get(symbol);
      if (bound) return bound;
      const declaration = symbol.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) {
        return evaluate(declaration.initializer, env, depth + 1);
      }
      return dynamic(node);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = evaluate(node.expression, env, depth + 1);
      if (base.k === "object" && base.props.has(node.name.text)) return base.props.get(node.name.text)!;
      if (base.k === "object" && !base.open) return constant(undefined);
      return dynamic(node);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map<string, Value>();
      let open: string | undefined;
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
          props.set(property.name.text, evaluate(property.initializer, env, depth + 1));
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(property);
          const bound = symbol ? env.get(symbol) : undefined;
          const declaration = symbol?.valueDeclaration;
          props.set(property.name.text, bound
            || (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
              && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)
              ? evaluate(declaration.initializer, env, depth + 1)
              : dynamic(property.name)));
        } else if (ts.isSpreadAssignment(property)) {
          const spread = evaluate(property.expression, env, depth + 1);
          if (spread.k === "object") {
            for (const [key, value] of spread.props) props.set(key, value);
            open ||= spread.open;
          } else if (!(spread.k === "const" && (spread.v === undefined || spread.v === null))) {
            open = shortText(property.expression);
          }
        } else {
          open = shortText(property);
        }
      }
      return { k: "object", props, ...(open ? { open } : {}) };
    }
    if (ts.isArrayLiteralExpression(node)) return { k: "array", items: node.elements.map(element => evaluate(element, env, depth + 1)) };
    if (ts.isConditionalExpression(node)) {
      const condition = evaluate(node.condition, env, depth + 1);
      if (condition.k === "const") return evaluate(condition.v ? node.whenTrue : node.whenFalse, env, depth + 1);
      return alt(evaluate(node.whenTrue, env, depth + 1), evaluate(node.whenFalse, env, depth + 1));
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      const left = evaluate(node.left, env, depth + 1);
      if (left.k === "const") {
        const keep = node.operatorToken.kind === ts.SyntaxKind.BarBarToken ? Boolean(left.v) : left.v !== undefined && left.v !== null;
        return keep ? left : evaluate(node.right, env, depth + 1);
      }
      if (left.k === "object" || left.k === "array") return left;
      return alt(left, evaluate(node.right, env, depth + 1));
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const value = evaluate(span.expression, env, depth + 1);
        if (value.k !== "const") return dynamic(node);
        text += String(value.v) + span.literal.text;
      }
      return constant(text);
    }
    return dynamic(node);
  }

  function render(value: Value): unknown {
    if (value.k === "const") return value.v;
    if (value.k === "array") return value.items.map(render);
    if (value.k === "alt") return { one_of: value.options.map(option => render(option) ?? null) };
    if (value.k === "dynamic") return { dynamic: value.text };
    const result: Json = {};
    for (const [key, entry] of value.props) {
      const rendered = render(entry);
      if (rendered !== undefined) result[key] = rendered;
    }
    if (value.open) result["..."] = value.open;
    return result;
  }

  // -- which functions can reach a gate at all

  const reaches = new Map<ts.Node, boolean>();
  function interesting(fn: ts.FunctionLikeDeclaration): boolean {
    const known = reaches.get(fn);
    if (known !== undefined) return known;
    reaches.set(fn, false);
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isPropertyAccessExpression(node) && node.name.text === "applicationAccess") { found = true; return; }
      if (ts.isCallExpression(node)) {
        const target = callee(node);
        if (target) {
          if ((isAuthFile(target.declaration) && (target.name === GATE || target.name in CHECKS))
            || (isPublicationContextFile(target.declaration) && PUBLICATION_GATES.has(target.name))) { found = true; return; }
          if (target.fn && inProject(target.fn) && !isAuthFile(target.fn) && interesting(target.fn)) { found = true; return; }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    reaches.set(fn, found);
    return found;
  }

  function walk(fn: ts.FunctionLikeDeclaration, env: Map<ts.Symbol, Value>, depth: number, stack: Set<ts.Node>, out: Finding) {
    const add = (list: string[], value: string) => { if (!list.includes(value)) list.push(value); };
    const visit = (node: ts.Node) => {
      // A helper declared inside is read where it is called, with its arguments.
      if (node !== fn && (ts.isFunctionDeclaration(node)
        || ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)))) return;
      if (ts.isPropertyAccessExpression(node) && node.name.text === "applicationAccess") out.readsApplicationAccess = true;
      if (ts.isCallExpression(node)) {
        const target = callee(node);
        if (target && isAuthFile(target.declaration) && target.name === GATE) {
          const options = node.arguments[1];
          add(out.gates, JSON.stringify(render(options ? evaluate(options, env) : { k: "object", props: new Map() })));
        } else if (target && isAuthFile(target.declaration) && target.name in CHECKS) {
          const index = CHECKS[target.name]!;
          const argument = index >= 0 ? node.arguments[index] : undefined;
          const rendered = argument ? render(evaluate(argument, env)) : undefined;
          add(out.checks, argument ? `${target.name}(${typeof rendered === "string" ? rendered : "dynamic"})` : target.name);
        } else if (target && isPublicationContextFile(target.declaration) && PUBLICATION_GATES.has(target.name)) {
          out.publication = true;
        } else if (target?.fn && inProject(target.fn) && !isAuthFile(target.fn) && !stack.has(target.fn)
          && depth < MAX_DEPTH && interesting(target.fn)) {
          const next = new Map(env);
          target.fn.parameters.forEach((parameter, index) => {
            if (!ts.isIdentifier(parameter.name)) return;
            const symbol = checker.getSymbolAtLocation(parameter.name);
            if (!symbol) return;
            const argument = node.arguments[index];
            let value = argument && !ts.isSpreadElement(argument) ? evaluate(argument, env) : constant(undefined);
            if (value.k === "const" && value.v === undefined && parameter.initializer) value = evaluate(parameter.initializer, next);
            next.set(symbol, value);
          });
          stack.add(target.fn);
          walk(target.fn, next, depth + 1, stack, out);
          stack.delete(target.fn);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
  }

  function functionAt(location: Location): ts.FunctionLikeDeclaration | null {
    const source = sourceByPath.get(slash(location.file).toLowerCase());
    if (!source) return null;
    const lineStarts = source.getLineStarts();
    const lineStart = lineStarts[location.line - 1];
    if (lineStart === undefined) return null;
    const position = lineStart + Math.max(0, location.column - 1);
    let best: ts.FunctionLikeDeclaration | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    const visit = (node: ts.Node) => {
      if (node.end < position - 1 || node.getFullStart() > position + 200) return;
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.body) {
        // The reported position is the function's own start, or for a declaration its name or parameter list.
        const anchors = [node.getStart(source), node.parameters.pos, node.name ? node.name.getStart(source) : node.getStart(source)];
        const distance = Math.min(...anchors.map(anchor => Math.abs(anchor - position)));
        if (distance < bestDistance) { best = node; bestDistance = distance; }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return bestDistance <= 12 ? best : null;
  }

  const cache = new Map<ts.Node, Finding>();
  function analyze(location: Location): Finding | null {
    const fn = functionAt(location);
    if (!fn) return null;
    const cached = cache.get(fn);
    if (cached) return cached;
    const out: Finding = { gates: [], checks: [], readsApplicationAccess: false, publication: false };
    walk(fn, new Map(), 0, new Set([fn]), out);
    cache.set(fn, out);
    return out;
  }

  return { analyze };
}

// ---------------------------------------------------------------------------
// The record.

function canonicalApplication(value: unknown) {
  const id = String(value ?? "").trim().toLowerCase();
  if (["main", "portal"].includes(id)) return "management";
  if (["crew", "workforce"].includes(id)) return "field";
  return id;
}

/** One `requirePlatformAuth` call as the snapshot states it. */
function describeGate(serialized: string): Json {
  const options = JSON.parse(serialized);
  if (!options || typeof options !== "object" || options.dynamic) return { application: "unknown", options };
  const gate: Json = {};
  // Leaving `application` out means the management application; `false` means any member.
  const label = (application: unknown): string => {
    if (application === undefined || application === null) return "management";
    if (application === false) return "any";
    if (typeof application === "string") return canonicalApplication(application);
    if (Array.isArray(application) && application.every(item => typeof item === "string")) {
      return [...new Set(application.map(canonicalApplication))].sort().join("|");
    }
    if (Array.isArray((application as Json).one_of)) return `one_of(${(application as Json).one_of.map(label).join(",")})`;
    return "unknown";
  };
  gate.application = label(options.application);
  if (gate.application === "unknown") gate.application_expression = options.application;
  if (options.applicationPermission !== undefined) gate.application_permission = options.applicationPermission;
  if (options.permission !== undefined) gate.permission = options.permission;
  if (options.allowScopedPermission !== undefined) gate.scoped = options.allowScopedPermission;
  if (options.capability !== undefined) gate.capability = options.capability;
  if (options.appId !== undefined) gate.app_id = options.appId;
  if (options.csrf !== undefined) gate.csrf = options.csrf;
  if (options["..."] !== undefined) gate.also = options["..."];
  return gate;
}

const gateNeedsPermission = (gate: Json) => gate.permission !== undefined || gate.application_permission !== undefined;

/** A hook's gate runs before the handler's, so both apply: the narrower application, and a permission if either asks one. */
function gateKind(gate: Json, hooks: Json[]) {
  let application = String(gate.application);
  let permission = gateNeedsPermission(gate);
  for (const hook of hooks) {
    permission ||= gateNeedsPermission(hook);
    const hookApplication = String(hook.application);
    if (hookApplication === "any" || hookApplication === application) continue;
    if (application === "any") { application = hookApplication; continue; }
    const shared = application.split("|").filter(item => hookApplication.split("|").includes(item));
    application = /^[a-z|]+$/.test(application) && /^[a-z|]+$/.test(hookApplication) ? (shared.join("|") || "none") : `${hookApplication}&${application}`;
  }
  return `${application}:${permission ? "permission" : "login_only"}`;
}

function routeKind(entry: Json) {
  const hooks: Json[] = entry.hook_gates || [];
  // With no gate of its own, a handler is gated by its hooks alone.
  const gates: Json[] = entry.gates?.length ? entry.gates : hooks.slice(0, 1);
  if (!gates.length) {
    if (entry.unresolved) return "unresolved";
    if (entry.library) return "library_route";
    return entry.publication ? "publication_policy" : "no_platform_session";
  }
  // Several gates in one handler are branches of it; they are counted as mixed when they differ.
  const kinds = [...new Set(gates.map(gate => gateKind(gate, hooks)))];
  if (kinds.length > 1) return `mixed(${kinds.sort().join(",")})`;
  const kind = kinds[0]!;
  // "Login only" at the entrance may still be followed by a check in the handler.
  return kind.endsWith(":login_only") && (entry.checks?.length || entry.publication) ? `${kind}+handler_checks` : kind;
}

function countBy<T>(items: T[], key: (item: T) => string) {
  const result: Record<string, number> = {};
  for (const item of items) result[key(item)] = (result[key(item)] || 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function applicationsLabel(value: unknown) {
  if (value === false) return "any";
  const list = Array.isArray(value) ? value : ["management"];
  return list.length ? [...new Set(list.map(canonicalApplication))].sort().join("|") : "any";
}

function operationKind(policy: Json) {
  const permissions = (policy.permissions || []).filter(Boolean);
  return `${applicationsLabel(policy.applications)}:${permissions.length || policy.applicationPermission ? "permission" : "membership_only"}`;
}

function serialize(snapshot: { summary: Json; routes: Json; data: Json; actions: Json; tabs: Json }) {
  const lines = ["{"];
  const section = (name: string, value: Json, last = false) => {
    lines.push(`  ${JSON.stringify(name)}: {`);
    const keys = Object.keys(value).sort();
    keys.forEach((key, index) => lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value[key])}${index === keys.length - 1 ? "" : ","}`));
    lines.push(last ? "  }" : "  },");
  };
  lines.push(`  "summary": ${JSON.stringify(snapshot.summary, null, 2).replace(/\n/g, "\n  ")},`);
  section("routes", snapshot.routes);
  section("data", snapshot.data);
  section("actions", snapshot.actions);
  section("tabs", snapshot.tabs, true);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

async function buildSnapshot() {
  const mainRouter = [...countRouters()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const registered = seen.filter(entry => entry.router === mainRouter && typeof entry.store?.handler === "function");
  const getUrls = new Set(registered.filter(entry => entry.method === "GET").map(entry => entry.url));
  // Fastify adds a HEAD route for every GET; it runs the same handler.
  const routes = registered.filter(entry => !(entry.method === "HEAD" && getUrls.has(entry.url)));

  const functions: Function[] = [];
  const indexOf = new Map<Function, number>();
  const remember = (fn: unknown) => {
    if (typeof fn !== "function") return -1;
    if (!indexOf.has(fn)) { indexOf.set(fn, functions.length); functions.push(fn); }
    return indexOf.get(fn)!;
  };
  const plan = routes.map(route => ({
    route,
    handler: remember(route.store.handler),
    hooks: HOOK_STAGES.flatMap(stage => (Array.isArray(route.store[stage]) ? route.store[stage] : []).map(remember))
  }));
  const locations = await locateFunctions(functions);
  const projectFile = (location: Location | null | undefined): location is Location =>
    Boolean(location && !slash(location.file).includes("/node_modules/") && slash(location.file).startsWith(slash(v1Root)));
  const analyzer = createAnalyzer([...new Set(locations.filter(projectFile).map(location => location.file))]);

  const routeEntries: Json = {};
  for (const item of plan) {
    const key = `${item.route.method} ${item.route.url}`;
    const location = locations[item.handler];
    const entry: Json = {};
    const finding = projectFile(location) ? analyzer.analyze(location) : null;
    if (projectFile(location)) entry.file = relative(location.file);
    // A route a library registers for itself (the CORS preflight) has no handler of ours to read.
    if (location && !projectFile(location)) entry.library = true;
    else if (!finding) entry.unresolved = true;
    else {
      if (finding.gates.length) entry.gates = finding.gates.map(describeGate);
      if (finding.checks.length) entry.checks = finding.checks;
      if (finding.publication) entry.publication = true;
      if (finding.readsApplicationAccess) entry.reads_application_access = true;
    }
    const hookGates: Json[] = [];
    for (const hook of item.hooks) {
      const hookLocation = locations[hook];
      const hookFinding = projectFile(hookLocation) ? analyzer.analyze(hookLocation) : null;
      for (const gate of hookFinding?.gates || []) hookGates.push(describeGate(gate));
    }
    if (hookGates.length) entry.hook_gates = hookGates;
    entry.kind = routeKind(entry);
    assert.equal(routeEntries[key], undefined, `Route ${key} is registered twice.`);
    routeEntries[key] = entry;
  }

  const { listActions } = await import("../platform/publication/actions.js");
  const { listDataProviders } = await import("../platform/publication/providers.js");
  const { accessCatalog } = await import("../workforce/access.js");
  const policyEntry = (policy: Json) => ({
    applications: applicationsLabel(policy.applications),
    ...(policy.applicationPermission ? { application_permission: policy.applicationPermission } : {}),
    permissions: policy.permissions || [],
    ...(policy.scopedPermissions ? { scoped: true } : {}),
    ...(policy.capabilities?.length ? { capabilities: policy.capabilities } : {}),
    scopes: policy.scopes || [],
    ...(policy.systemKinds?.length ? { system_kinds: policy.systemKinds } : {}),
    kind: operationKind(policy)
  });
  const data: Json = {};
  for (const provider of listDataProviders() as Json[]) {
    for (const [name, exported] of Object.entries(provider.exports as Json)) {
      data[`${provider.id}.${name}@${provider.version}`] = policyEntry((exported as Json).access);
    }
  }
  const actions: Json = {};
  for (const action of listActions() as Json[]) {
    actions[`${action.id}@${action.version}`] = { ...policyEntry(action.policy), effect: action.effect, execution_kinds: action.executionKinds };
  }
  const tabs: Json = {};
  for (const tab of accessCatalog() as Json[]) {
    tabs[tab.id] = {
      application: tab.application_id,
      surface: tab.surface,
      devices: tab.devices,
      required_permissions: tab.required_permissions,
      permission_mode: tab.permission_mode,
      default_enabled: tab.default_enabled
    };
  }

  const routeList = Object.values(routeEntries) as Json[];
  const summary = {
    routes: { total: routeList.length, by_kind: countBy(routeList, entry => String(entry.kind)), reading_application_access: routeList.filter(entry => entry.reads_application_access).length },
    data: { total: Object.keys(data).length, by_kind: countBy(Object.values(data) as Json[], entry => String(entry.kind)) },
    actions: { total: Object.keys(actions).length, by_kind: countBy(Object.values(actions) as Json[], entry => String(entry.kind)) },
    tabs: { total: Object.keys(tabs).length, by_application: countBy(Object.values(tabs) as Json[], entry => String(entry.application)) }
  };
  return { summary, routes: routeEntries, data, actions, tabs };
}

function countRouters() {
  const counts = new Map<unknown, number>();
  for (const entry of seen) counts.set(entry.router, (counts.get(entry.router) || 0) + 1);
  return counts;
}

function differences(expected: Json, actual: Json) {
  const lines: string[] = [];
  for (const section of ["routes", "data", "actions", "tabs"]) {
    const before = expected[section] || {};
    const now = actual[section] || {};
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(now)])].sort()) {
      const left = JSON.stringify(before[key]);
      const right = JSON.stringify(now[key]);
      if (left === right) continue;
      if (left === undefined) lines.push(`+ ${section} ${key}: ${right}`);
      else if (right === undefined) lines.push(`- ${section} ${key}: ${left}`);
      else lines.push(`~ ${section} ${key}\n    was ${left}\n    now ${right}`);
    }
  }
  return lines;
}

test("every route, published data export, published action and tab keeps the gate recorded in the snapshot", async () => {
  const snapshot = await buildSnapshot();
  const text = serialize(snapshot);

  // The record is only worth comparing if it was really read from the application.
  assert.ok(snapshot.summary.routes.total > 900, `Only ${snapshot.summary.routes.total} routes were observed.`);
  const unresolved = Object.entries(snapshot.routes).filter(([, entry]) => (entry as Json).unresolved).map(([key]) => key);
  assert.deepEqual(unresolved, [], "These route handlers could not be found in the source.");
  assert.ok(snapshot.summary.data.total >= 33 && snapshot.summary.actions.total >= 80);
  assert.ok(Object.keys(snapshot.routes).includes("POST /v1/platform/auth/login"));

  if (process.env.UPDATE_APP_SPLIT_GATES === "1" || !existsSync(snapshotPath)) {
    writeFileSync(snapshotPath, text, "utf8");
    if (process.env.UPDATE_APP_SPLIT_GATES !== "1") assert.fail(`No snapshot existed; one was written to ${snapshotPath}. Review and commit it.`);
    return;
  }
  const expectedText = readFileSync(snapshotPath, "utf8").replace(/\r\n/g, "\n");
  if (expectedText === text) return;
  const changed = differences(JSON.parse(expectedText), JSON.parse(text));
  assert.fail([
    `${changed.length} access gate(s) differ from tests/app-split-gates.snapshot.json.`,
    "If the change is intended, rerun with UPDATE_APP_SPLIT_GATES=1 and commit the snapshot.",
    ...changed.slice(0, 60),
    ...(changed.length > 60 ? [`... and ${changed.length - 60} more`] : []),
    ...(changed.length ? [] : ["Only the summary or ordering differs."])
  ].join("\n"));
});
