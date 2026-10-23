import { createHash } from "node:crypto";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

/**
 * Session replay archive format (docs/architecture/session-replay.md, "Archives").
 *
 * A finished session is re-packed into one zstd stream. Each page is decoded with the
 * wire format's own rules (public/libraries/session-replay/session-replay-codec.js) and its
 * per-page string ids are renumbered onto a shared vocabulary, so the same markup in two
 * sessions becomes the same bytes however the pages interleaved their strings:
 *
 *   canonical id  2p      platform vocabulary token p (seen in several organizations)
 *                 2o + 1  organization vocabulary token o
 *                 -2 - k  the page's k-th string that is in neither (its text is kept in the page)
 *                 -1      unchanged where the wire uses it ("no value", "no doctype")
 *
 * A page's string table becomes a list whose numbers are vocabulary ids (delta coded) and whose
 * strings are the new texts. The stream is then compressed with zstd and the organization's
 * dictionary (recent sessions in this canonical form), so a page many people load costs a few
 * back-references. Every page is restored and compared with the original chunk JSON before it is
 * written canonically; a page that does not round-trip exactly is kept verbatim.
 */
export const ARCHIVE_FORMAT = 1;
const WIRE_FORMAT = 1;
const ZSTD_LEVEL = 19;

const E = { META: 0, SNAPSHOT: 1, MUT: 2, PTR: 3, SCROLL: 4, VIEW: 5, INPUT: 6, FOCUS: 7, HOVER: 8, KEY: 9, NAV: 10, VIS: 11, ERR: 12, DIAG: 13, FRAME: 14, SHADOW: 15, CUSTOM: 16, END: 17 };

export interface ArchiveVocabulary {
  /** Canonical id of a vocabulary string, or undefined. */
  idOf(text: string): number | undefined;
  /** Text of a canonical vocabulary id, or undefined. */
  textOf(id: number): string | undefined;
}

/** The pinned platform and organization token lists as one canonical id space. */
export function combineVocabularies(platform: readonly string[], organization: readonly string[]): ArchiveVocabulary {
  const ids = new Map<string, number>();
  platform.forEach((text, index) => { if (!ids.has(text)) ids.set(text, 2 * index); });
  organization.forEach((text, index) => { if (!ids.has(text)) ids.set(text, 2 * index + 1); });
  return {
    idOf: (text) => ids.get(text),
    textOf: (id) => {
      if (!Number.isInteger(id) || id < 0) return undefined;
      return id % 2 === 0 ? platform[id / 2] : organization[(id - 1) / 2];
    }
  };
}

export const EMPTY_VOCABULARY = combineVocabularies([], []);

export type SourceChunk = { seq: number; json: string };
/** [seq, v, t, table, events, pointer] */
type CanonicalChunk = [number, number, number, Array<number | string>, unknown[], unknown];
export type ArchivedPage = { i: string; c?: CanonicalChunk[]; r?: Array<[number, string]> };
export type SessionArchive = { f: number; p: ArchivedPage[] };

class Unsupported extends Error {}
const fail = (why: string): never => { throw new Unsupported(why); };
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

type SidMap = (sid: number) => number;

function mapAttrs(attrs: unknown, sid: SidMap) {
  if (attrs === 0) return 0;
  if (!Array.isArray(attrs) || attrs.length % 2) return fail("attributes");
  return attrs.map((value) => sid(value as number));
}

function mapChildren(children: unknown, sid: SidMap, toCanonical: boolean) {
  if (!Array.isArray(children)) return fail("children");
  return children.map((child) => mapTree(child, sid, toCanonical));
}

/** A wire tree to canonical form (toCanonical) or back. Elements whose tag is a page string are wrapped as {e}. */
function mapTree(node: unknown, sid: SidMap, toCanonical: boolean): unknown {
  if (typeof node === "number") return sid(node);
  if (Array.isArray(node)) {
    if (!node.length || !isInt(node[0])) return fail("node");
    if (node[0] < 0) {
      // Template reference [-1 - n, slot, value, ...]: n is the page's own numbering and stays.
      if (node.length % 2 !== 1) return fail("template reference");
      const out: number[] = [node[0]];
      for (let i = 1; i < node.length; i += 2) {
        if (!isInt(node[i])) return fail("template slot");
        out.push(node[i], sid(node[i + 1]));
      }
      return out;
    }
    if (node.length < 2) return fail("element");
    const out: unknown[] = [sid(node[0]), mapAttrs(node[1], sid)];
    for (let i = 2; i < node.length; i++) out.push(mapTree(node[i], sid, toCanonical));
    return toCanonical && (out[0] as number) < 0 ? { e: out } : out;
  }
  if (node && typeof node === "object") {
    const keys = Object.keys(node);
    const value = node as Record<string, unknown>;
    if (keys.length === 1 && keys[0] === "r") return { r: mapChildren(value.r, sid, toCanonical) };
    if (keys.length === 3 && keys[0] === "d" && keys[1] === "u" && keys[2] === "t") {
      return { d: mapChildren(value.d, sid, toCanonical), u: sid(value.u as number), t: value.t === -1 ? -1 : sid(value.t as number) };
    }
    if (!toCanonical && keys.length === 1 && keys[0] === "e" && Array.isArray(value.e)) {
      const element = value.e;
      if (element.length < 2 || !isInt(element[0]) || element[0] >= 0) return fail("page-tag element");
      const out: unknown[] = [sid(element[0]), mapAttrs(element[1], sid)];
      for (let i = 2; i < element.length; i++) out.push(mapTree(element[i], sid, false));
      return out;
    }
  }
  return fail("tree");
}

function groups(list: unknown, size: number) {
  if (list === 0) return null;
  if (!Array.isArray(list) || list.length % size) return fail("group list");
  return list;
}

/**
 * DOM node ids, delta coded against the last id seen in the same register so that a page whose
 * nodes are numbered a little differently (one more row above) still repeats byte for byte.
 * 0 ("none") stays 0; d >= 0 is written d + 1, a negative d as itself.
 */
class NodeIds {
  private last = [0, 0];
  private readonly toCanonical: boolean;
  private readonly registers: number;
  constructor(toCanonical: boolean, registers: number) {
    this.toCanonical = toCanonical;
    this.registers = registers;
  }
  map(id: unknown, register: number) {
    if (!isInt(id) || (this.toCanonical && id < 0)) return fail("node id");
    if (this.registers === 0) return id;
    const r = this.registers === 1 ? 0 : register;
    if (id === 0) return 0;
    if (this.toCanonical) {
      const d = id - (this.last[r] ?? 0);
      this.last[r] = id;
      return d >= 0 ? d + 1 : d;
    }
    const last = this.last[r] ?? 0;
    const value = id > 0 ? last + id - 1 : last + id;
    this.last[r] = value;
    return value;
  }
}
// Tree positions (adds, removes, attribute and text targets) and interaction targets (pointer, scroll,
// input, focus, hover, keys) move through the page differently, so each keeps its own last id.
const TREE = 0, TARGET = 1;
const NODE_ID_REGISTERS = 2;

/** One event with every string id and node id mapped. Positions follow the E table in session-replay-codec.js. */
function mapEvent(event: unknown, sid: SidMap, nodes: NodeIds, toCanonical: boolean): unknown[] {
  if (!Array.isArray(event) || event.length < 2 || !isInt(event[1])) return fail("event");
  const type = event[1];
  const out = event.slice();
  const tree = (node: unknown) => mapTree(node, sid, toCanonical);
  const node = (index: number, register: number) => { out[index] = nodes.map(event[index], register); };
  switch (type) {
    case E.META: case E.NAV:
      if (event.length !== 3) fail("event length");
      out[2] = sid(event[2]);
      break;
    case E.SNAPSHOT:
      if (event.length !== 4) fail("event length");
      node(2, TREE);
      out[3] = tree(event[3]);
      break;
    case E.FRAME: case E.SHADOW:
      if (event.length !== 5) fail("event length");
      node(2, TREE); node(3, TREE);
      out[4] = tree(event[4]);
      break;
    case E.MUT: {
      if (event.length !== 6) fail("event length");
      const removes = groups(event[2], 1), adds = groups(event[3], 4), attrs = groups(event[4], 3), texts = groups(event[5], 2);
      if (removes) out[2] = removes.map((id) => nodes.map(id, TREE));
      if (adds) {
        const next = adds.slice();
        for (let i = 0; i < next.length; i += 4) {
          next[i] = nodes.map(next[i], TREE);
          next[i + 1] = nodes.map(next[i + 1], TREE);
          next[i + 2] = nodes.map(next[i + 2], TREE);
          next[i + 3] = tree(next[i + 3]);
        }
        out[3] = next;
      }
      if (attrs) {
        const next = attrs.slice();
        for (let i = 0; i < next.length; i += 3) {
          next[i] = nodes.map(next[i], TREE);
          next[i + 1] = sid(next[i + 1]);
          next[i + 2] = next[i + 2] === -1 ? -1 : sid(next[i + 2]);
        }
        out[4] = next;
      }
      if (texts) {
        const next = texts.slice();
        for (let i = 0; i < next.length; i += 2) {
          next[i] = nodes.map(next[i], TREE);
          next[i + 1] = sid(next[i + 1]);
        }
        out[5] = next;
      }
      break;
    }
    case E.PTR:
      if (event.length !== 8 && event.length !== 10) fail("event length");
      node(3, TARGET);
      if (event.length === 10) { out[8] = sid(event[8]); out[9] = sid(event[9]); }
      break;
    case E.SCROLL:
      if (event.length !== 5) fail("event length");
      node(2, TARGET);
      break;
    case E.FOCUS:
      if (event.length !== 4) fail("event length");
      node(2, TARGET);
      break;
    case E.HOVER:
      if (event.length !== 3) fail("event length");
      node(2, TARGET);
      break;
    case E.INPUT:
      if (event.length < 4) fail("event length");
      node(2, TARGET);
      if (event[3] === 0 && event.length === 5) out[4] = sid(event[4]);
      else if (event[3] === 2 && event.length === 7) out[6] = sid(event[6]);
      else if (!(event[3] === 1 && event.length === 5)) fail("input event");
      break;
    case E.KEY:
      if (event.length !== 5) fail("event length");
      out[2] = sid(event[2]);
      node(4, TARGET);
      break;
    case E.ERR:
      if (event.length !== 6) fail("event length");
      out[2] = sid(event[2]); out[3] = sid(event[3]);
      break;
    case E.CUSTOM:
      if (event.length !== 4) fail("event length");
      out[2] = sid(event[2]); out[3] = sid(event[3]);
      break;
    case E.VIEW: case E.VIS: case E.DIAG: case E.END:
      break;
    default:
      fail("event type " + type);
  }
  return out;
}

type ParsedChunk = { seq: number; v: number; t: number; s: string[]; e: unknown[]; m: unknown };

function parseChunk(chunk: SourceChunk): ParsedChunk {
  const value = JSON.parse(chunk.json) as Record<string, unknown>;
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  if (keys.join(",") !== "v,t,s,e,m" || value.v !== WIRE_FORMAT || typeof value.t !== "number") return fail("chunk shape");
  if (!Array.isArray(value.s) || value.s.some((s) => typeof s !== "string") || !Array.isArray(value.e)) return fail("chunk shape");
  return { seq: chunk.seq, v: value.v, t: value.t, s: value.s as string[], e: value.e, m: value.m };
}

function canonicalPage(pageId: string, chunks: SourceChunk[], vocabulary: ArchiveVocabulary): ArchivedPage {
  const parsed = chunks.map(parseChunk);
  const canonical: number[] = [];
  const used = new Set<number>();
  let fresh = 0;
  const tables = parsed.map((chunk) => {
    let previous = 0;
    return chunk.s.map((text) => {
      const id = vocabulary.idOf(text);
      if (id !== undefined && !used.has(id)) {
        used.add(id);
        canonical.push(id);
        const delta = id - previous;
        previous = id;
        return delta;
      }
      canonical.push(-2 - fresh++);
      return text;
    });
  });
  const sid: SidMap = (local) => {
    const id = isInt(local) && local >= 0 ? canonical[local] : undefined;
    return id === undefined ? fail("string id") : id;
  };
  const nodes = new NodeIds(true, NODE_ID_REGISTERS);
  return {
    i: pageId,
    c: parsed.map((chunk, index): CanonicalChunk => [chunk.seq, chunk.v, chunk.t, tables[index] ?? [], chunk.e.map((event) => mapEvent(event, sid, nodes, true)), chunk.m])
  };
}

/** The original chunk JSON of an archived page. */
export function restorePage(page: ArchivedPage, vocabulary: ArchiveVocabulary): SourceChunk[] {
  if (page.r) return page.r.map(([seq, json]) => ({ seq, json }));
  if (!page.c) return fail("page");
  const strings: string[] = [];
  const vocabularyLocal = new Map<number, number>();
  const freshLocal: number[] = [];
  const perChunk = page.c.map(([, , , table]) => {
    let previous = 0;
    return table.map((entry) => {
      if (typeof entry === "string") {
        freshLocal.push(strings.length);
        strings.push(entry);
        return entry;
      }
      const id = previous + entry;
      previous = id;
      const text = vocabulary.textOf(id);
      if (text === undefined) return fail("vocabulary id " + id);
      vocabularyLocal.set(id, strings.length);
      strings.push(text);
      return text;
    });
  });
  const sid: SidMap = (id) => {
    const local = id >= 0 ? vocabularyLocal.get(id) : freshLocal[-2 - id];
    if (local === undefined) return fail("canonical id " + id);
    return local;
  };
  const nodes = new NodeIds(false, NODE_ID_REGISTERS);
  return page.c.map(([seq, v, t, , events, m], index) => ({
    seq, json: JSON.stringify({ v, t, s: perChunk[index], e: events.map((event) => mapEvent(event, sid, nodes, false)), m })
  }));
}

/**
 * One page in archive form. Canonical when it restores to exactly the given JSON, else verbatim.
 * `reason` says why a page was kept verbatim.
 */
export function archivePage(pageId: string, chunks: SourceChunk[], vocabulary: ArchiveVocabulary): { page: ArchivedPage; canonical: boolean; reason?: string } {
  try {
    const page = canonicalPage(pageId, chunks, vocabulary);
    const restored = restorePage(JSON.parse(JSON.stringify(page)) as ArchivedPage, vocabulary);
    if (restored.length === chunks.length && restored.every((chunk, index) => chunk.seq === chunks[index]?.seq && chunk.json === chunks[index]?.json)) {
      return { page, canonical: true };
    }
    return { page: { i: pageId, r: chunks.map((chunk) => [chunk.seq, chunk.json]) }, canonical: false, reason: "round trip differs" };
  } catch (error) {
    const reason = error instanceof Unsupported || error instanceof SyntaxError ? (error as Error).message : String(error);
    return { page: { i: pageId, r: chunks.map((chunk) => [chunk.seq, chunk.json]) }, canonical: false, reason };
  }
}

/** The distinct strings of a page's table (what vocabulary statistics count). */
export function pageStrings(chunks: SourceChunk[]): string[] {
  const seen = new Set<string>();
  for (const chunk of chunks) {
    try {
      const value = JSON.parse(chunk.json) as { s?: unknown };
      if (Array.isArray(value.s)) for (const text of value.s) if (typeof text === "string") seen.add(text);
    } catch { /* unreadable chunks contribute nothing */ }
  }
  return [...seen];
}

/**
 * A page as dictionary content: its canonical form with every literal string blanked, so a dictionary
 * carries structure and vocabulary ids but no text. Null for a verbatim page.
 */
export function dictionaryPiece(page: ArchivedPage) {
  if (!page.c) return null;
  return JSON.stringify({ i: "", c: page.c.map(([seq, v, t, table, events, m]) => [seq, v, t, table.map((entry) => typeof entry === "string" ? "" : entry), events, m]) });
}

export function serializeArchive(archive: SessionArchive) {
  return Buffer.from(JSON.stringify(archive), "utf8");
}

export function compressArchive(serialized: Buffer, dictionary: Buffer | null) {
  return zstdCompressSync(serialized, {
    params: {
      [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL,
      [constants.ZSTD_c_enableLongDistanceMatching]: 1,
      [constants.ZSTD_c_windowLog]: 24
    },
    ...(dictionary && dictionary.length ? { dictionary } : {})
  });
}

export function decompressArchive(packed: Buffer, dictionary: Buffer | null, maxBytes = 512 * 1024 * 1024): SessionArchive {
  const raw = zstdDecompressSync(packed, { ...(dictionary && dictionary.length ? { dictionary } : {}), maxOutputLength: maxBytes });
  const archive = JSON.parse(raw.toString("utf8")) as SessionArchive;
  if (archive.f !== ARCHIVE_FORMAT || !Array.isArray(archive.p)) return fail("archive format");
  return archive;
}

export function sha256(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex");
}
