/**
 * Structural patches over JSON values: the diff format of document history.
 *
 * A patch is a list of operations applied in order. Each names a path of
 * object keys and array indices from the root:
 *
 *   ["s", path, value]                      set (or add) the value at path
 *   ["d", path]                             delete an object key
 *   ["a", path, index, deleteCount, items]  splice the array at path
 *
 * Arrays are aligned by element identity — an object's string `id` when it has
 * one (document nodes, blocks, line items), otherwise its content — so a moved
 * or edited block costs its own change, not the rest of the list. Elements
 * with the same id but different content are diffed recursively.
 *
 * applyPatch(before, diffJson(before, after)) equals `after` exactly
 * (stableStringify of both is identical). Only JSON values are supported;
 * undefined object members are treated as absent, as JSON does.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type PathPart = string | number;
export type PatchOp =
  | ["s", PathPart[], JsonValue]
  | ["d", PathPart[]]
  | ["a", PathPart[], number, number, JsonValue[]];

/** Above this many cell comparisons an array falls back to trimming common ends and splicing the middle. */
const MAX_ALIGNMENT_CELLS = 4_000_000;

function isObject(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Canonical JSON: object keys sorted, undefined members dropped. Checksums are taken over this. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : stableStringify(item)).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function identity(value: JsonValue, memo: Map<JsonValue, string>): string {
  if (isObject(value) && typeof value.id === "string" && value.id) return `#${value.id}`;
  if (value !== null && typeof value === "object") {
    let key = memo.get(value);
    if (key === undefined) { key = `=${stableStringify(value)}`; memo.set(value, key); }
    return key;
  }
  return `=${JSON.stringify(value)}`;
}

function equal(a: JsonValue, b: JsonValue, memo: Map<JsonValue, string>) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = memo.get(a) ?? stableStringify(a); memo.set(a, ka);
  const kb = memo.get(b) ?? stableStringify(b); memo.set(b, kb);
  return ka === kb;
}

/** Longest common subsequence of two key lists, as matched index pairs. */
function align(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length, m = b.length, cols = m + 1;
  const table = new Uint32Array((n + 1) * cols);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

function diffArray(path: PathPart[], a: JsonValue[], b: JsonValue[], ops: PatchOp[], memo: Map<JsonValue, string>) {
  // Common ends first: most edits touch a small window of a long list.
  let start = 0;
  while (start < a.length && start < b.length && equal(a[start]!, b[start]!, memo)) start += 1;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && equal(a[endA - 1]!, b[endB - 1]!, memo)) { endA -= 1; endB -= 1; }
  if (start === endA && start === endB) return;
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  // Gaps between anchors, collected left to right and emitted right to left so
  // every index an operation names is still valid when it runs.
  type Gap = { at: number; from: JsonValue[]; to: JsonValue[]; pair?: [JsonValue, JsonValue] };
  const gaps: Gap[] = [];
  if (midA.length * midB.length > MAX_ALIGNMENT_CELLS) {
    gaps.push({ at: start, from: midA, to: midB });
  } else {
    const keysA = midA.map((value) => identity(value, memo));
    const keysB = midB.map((value) => identity(value, memo));
    let i = 0, j = 0;
    for (const [pi, pj] of align(keysA, keysB)) {
      if (pi > i || pj > j) gaps.push({ at: start + i, from: midA.slice(i, pi), to: midB.slice(j, pj) });
      if (!equal(midA[pi]!, midB[pj]!, memo)) gaps.push({ at: start + pi, from: [], to: [], pair: [midA[pi]!, midB[pj]!] });
      i = pi + 1; j = pj + 1;
    }
    if (i < midA.length || j < midB.length) gaps.push({ at: start + i, from: midA.slice(i), to: midB.slice(j) });
  }
  for (let index = gaps.length - 1; index >= 0; index -= 1) {
    const gap = gaps[index]!;
    if (gap.pair) { diffInto([...path, gap.at], gap.pair[0], gap.pair[1], ops, memo); continue; }
    if (gap.from.length && gap.from.length === gap.to.length) {
      // Same count replaced in place: edit each element rather than resend them.
      for (let k = gap.from.length - 1; k >= 0; k -= 1) diffInto([...path, gap.at + k], gap.from[k]!, gap.to[k]!, ops, memo);
      continue;
    }
    ops.push(["a", path, gap.at, gap.from.length, cloneJson(gap.to)]);
  }
}

function diffInto(path: PathPart[], a: JsonValue, b: JsonValue, ops: PatchOp[], memo: Map<JsonValue, string>) {
  if (a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) { diffArray(path, a, b, ops, memo); return; }
  if (isObject(a) && isObject(b)) {
    for (const key of Object.keys(a)) {
      if (a[key] === undefined) continue;
      if (b[key] === undefined) ops.push(["d", [...path, key]]);
    }
    for (const key of Object.keys(b)) {
      if (b[key] === undefined) continue;
      if (a[key] === undefined) ops.push(["s", [...path, key], cloneJson(b[key]!)]);
      else diffInto([...path, key], a[key]!, b[key]!, ops, memo);
    }
    return;
  }
  if (equal(a, b, memo)) return;
  ops.push(["s", path, cloneJson(b)]);
}

/** The operations that turn `before` into `after`. Empty when they are equal. */
export function diffJson(before: unknown, after: unknown): PatchOp[] {
  const ops: PatchOp[] = [];
  diffInto([], cloneJson((before ?? null) as JsonValue), cloneJson((after ?? null) as JsonValue), ops, new Map());
  return ops;
}

function parentOf(root: { value: JsonValue }, path: PathPart[]): [JsonValue, PathPart] {
  let node: JsonValue = root as unknown as JsonValue;
  const full: PathPart[] = ["value", ...path];
  for (let i = 0; i < full.length - 1; i += 1) {
    const next = (node as Record<string, JsonValue>)[full[i] as string];
    if (next === null || typeof next !== "object") throw new Error(`Patch path ${JSON.stringify(path)} does not exist.`);
    node = next;
  }
  return [node, full[full.length - 1]!];
}

/** Apply a patch to a copy of `value`; the input is not modified. */
export function applyPatch<T = JsonValue>(value: unknown, ops: PatchOp[]): T {
  const root = { value: cloneJson((value ?? null) as JsonValue) };
  for (const op of ops) {
    if (op[0] === "s") {
      if (!op[1].length) { root.value = cloneJson(op[2]); continue; }
      const [parent, key] = parentOf(root, op[1]);
      (parent as Record<string, JsonValue>)[key as string] = cloneJson(op[2]);
    } else if (op[0] === "d") {
      const [parent, key] = parentOf(root, op[1]);
      delete (parent as Record<string, JsonValue>)[key as string];
    } else if (op[0] === "a") {
      const target = op[1].length ? (() => { const [parent, key] = parentOf(root, op[1]); return (parent as Record<string, JsonValue>)[key as string]; })() : root.value;
      if (!Array.isArray(target)) throw new Error(`Patch path ${JSON.stringify(op[1])} is not an array.`);
      target.splice(op[2], op[3], ...cloneJson(op[4]));
    } else {
      throw new Error(`Unknown patch operation ${JSON.stringify((op as unknown[])[0])}.`);
    }
  }
  return root.value as T;
}

/** Top-level keys a patch touches (what a revision changed, for its summary). */
export function touchedSections(ops: PatchOp[]): string[] {
  const keys = new Set<string>();
  for (const op of ops) {
    const first = op[1][0];
    keys.add(first === undefined ? "*" : String(first));
  }
  return [...keys].sort();
}
