import { createHash, randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync, constants } from "node:zlib";

import * as codec from "./archive-codec.js";
import * as store from "./storage.js";

/**
 * Session replay archives (docs/architecture/session-replay.md, "Archives").
 *
 * A session with no chunk for `afterMs` is re-packed into one zstd stream (archive-codec.ts): its strings are
 * renumbered onto vocabularies shared across sessions and the stream is compressed with the organization's
 * dictionary. What archives share:
 *
 * - Vocabularies are append-only token lists, one per scope: the platform's (strings seen in
 *   `platformMinOrgs`+ organizations) and each organization's (strings seen in `orgMinSessions`+ of its
 *   sessions). A version adds tokens to the one before it and is never changed; a generation is a fresh list
 *   started when one fills up. An archive pins the versions it was written with.
 * - An organization version may also carry a dictionary: the newest load of each page address the
 *   organization recorded, in canonical form with literal text blanked. It is rebuilt only once the live
 *   bytes archived since the last one reach `dictionaryEvery` times its stored size, so its cost is spread.
 * - Text stays in the session's own archive (strings seen once), the organization's vocabulary or, when
 *   several organizations have it, the platform's. Deleting an organization removes its sessions, archives,
 *   vocabulary and statistics; nothing shared changes.
 *
 * Every archive is decoded with the vocabulary and dictionary as stored and compared with every original
 * chunk before the chunk bodies are emptied. A dry run does everything in memory and writes only its report.
 */

export type ArchiveSettings = {
  afterMs: number;
  orgMinSessions: number;
  platformMinOrgs: number;
  platformTokenChars: number;
  orgTokenChars: number;
  maxPlatformTokens: number;
  maxOrgTokens: number;
  maxTokenBytes: number;
  maxVersions: number;
  versionBatchTokens: number;
  versionEveryMs: number;
  youngSessions: number;
  dictionaryBytes: number;
  dictionaryLoadMs: number;
  dictionaryEvery: number;
  dictionaryMinBytes: number;
  dictionarySessions: number;
  dictionaryAddresses: number;
  maxSessionBytes: number;
  limit: number;
};

const DAY = 24 * 60 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const STATS_STALE_MS = 30 * DAY;
const STATS_KEEP_ROWS = 250_000;
const VOCAB_CACHE = 16;
const DECODED_CACHE = 6;
const DECODED_TTL_MS = 10 * 60 * 1000;

const envNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/** Operating settings. These are platform operations (how hard storage works), not business choices. */
export function archiveSettings(): ArchiveSettings {
  return {
    afterMs: envNumber("SESSION_REPLAY_ARCHIVE_AFTER_DAYS", 7) * DAY,
    orgMinSessions: envNumber("SESSION_REPLAY_VOCAB_ORG_SESSIONS", 2),
    platformMinOrgs: envNumber("SESSION_REPLAY_VOCAB_PLATFORM_ORGS", 3),
    platformTokenChars: 512,
    orgTokenChars: 2047,
    maxPlatformTokens: 40_000,
    maxOrgTokens: 60_000,
    maxTokenBytes: 4 * 1024 * 1024,
    maxVersions: 500,
    versionBatchTokens: 32,
    versionEveryMs: 60 * 60 * 1000,
    youngSessions: 20,
    dictionaryBytes: 256 * 1024,
    dictionaryLoadMs: 15_000,
    dictionaryEvery: 32,
    dictionaryMinBytes: 128 * 1024,
    dictionarySessions: 12,
    dictionaryAddresses: 60,
    maxSessionBytes: 48 * 1024 * 1024,
    limit: envNumber("SESSION_REPLAY_ARCHIVE_LIMIT", 400)
  };
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
const zstd = (data: Buffer) => zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: 19 } });
const unzstd = (data: Buffer) => data.length ? zstdDecompressSync(data, { maxOutputLength: 64 * 1024 * 1024 }) : Buffer.alloc(0);

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

type Pin = { generation: number; version: number };
type ScopeState = {
  scope: string;
  generation: number;
  version: number;
  versionAt: number;
  tokens: string[];
  index: Map<string, number>;
  bytes: number;
  pending: string[];
  pendingSet: Set<string>;
  /** Organization scopes: the platform version this one was built against, its dictionary and when to rebuild it. */
  platform: Pin;
  dictionaryVersion: number;
  dictionary: Buffer | null;
  dictionaryStored: number;
  bytesSinceDictionary: number;
  /** Newest load of each page address (organization scopes), newest last. */
  loads: Map<string, store.SourcePage>;
  seededLoads: boolean;
  archived: number;
};

async function readTokens(scope: string, generation: number, version: number) {
  const tokens: string[] = [];
  if (!generation || !version) return tokens;
  for (const blob of await store.readVocabTokenBlobs(scope, generation, version)) {
    const added = JSON.parse(unzstd(blob.tokens).toString("utf8")) as unknown;
    if (!Array.isArray(added)) throw new Error(`Session replay vocabulary ${scope} ${generation}.${blob.version} is unreadable.`);
    for (const text of added) tokens.push(String(text));
  }
  return tokens;
}

async function readDictionary(scope: string, generation: number, dictionaryVersion: number) {
  if (!generation || !dictionaryVersion) return null;
  const [owner, stored] = await Promise.all([store.readVocabVersion(scope, generation, dictionaryVersion), store.readVocabDictionary(scope, generation, dictionaryVersion)]);
  if (!owner || !stored) throw new Error(`Session replay dictionary ${scope} ${generation}.${dictionaryVersion} is missing.`);
  const dictionary = unzstd(stored);
  if (codec.sha256(dictionary) !== owner.dictionary_sha256) throw new Error(`Session replay dictionary ${scope} ${generation}.${dictionaryVersion} does not match its hash.`);
  return { dictionary: dictionary.length ? dictionary : null, stored: stored.length };
}

type Pinned = { vocabulary: codec.ArchiveVocabulary; dictionary: Buffer | null };
const vocabularyCache = new Map<string, Promise<Pinned>>();

/** The vocabulary and dictionary an archive pinned, as stored (cached: versions never change). */
async function pinnedVocabulary(organizationId: string, platform: Pin, org: Pin): Promise<Pinned> {
  const key = `${platform.generation}.${platform.version}|${organizationId}|${org.generation}.${org.version}`;
  const cached = vocabularyCache.get(key);
  if (cached) { vocabularyCache.delete(key); vocabularyCache.set(key, cached); return await cached; }
  const loading = (async () => {
    const [platformTokens, orgTokens] = await Promise.all([
      readTokens(store.PLATFORM_SCOPE, platform.generation, platform.version),
      readTokens(organizationId, org.generation, org.version)
    ]);
    let dictionary: Buffer | null = null;
    if (org.generation && org.version) {
      const row = await store.readVocabVersion(organizationId, org.generation, org.version);
      if (!row) throw new Error(`Session replay vocabulary ${organizationId} ${org.generation}.${org.version} is missing.`);
      dictionary = (await readDictionary(organizationId, org.generation, row.dictionary_version))?.dictionary || null;
    }
    return { vocabulary: codec.combineVocabularies(platformTokens, orgTokens), dictionary };
  })();
  vocabularyCache.set(key, loading);
  loading.catch(() => vocabularyCache.delete(key));
  while (vocabularyCache.size > VOCAB_CACHE) vocabularyCache.delete(vocabularyCache.keys().next().value as string);
  return await loading;
}

async function loadScope(scope: string): Promise<ScopeState> {
  const latest = await store.latestVocabVersion(scope);
  const tokens = latest ? await readTokens(scope, latest.generation, latest.version) : [];
  const state: ScopeState = {
    scope, generation: latest?.generation || 0, version: latest?.version || 0, versionAt: latest?.created_at || 0, tokens, index: new Map(), bytes: 0,
    pending: [], pendingSet: new Set(), platform: { generation: latest?.platform_generation || 0, version: latest?.platform_version || 0 },
    dictionaryVersion: latest?.dictionary_version || 0, dictionary: null, dictionaryStored: 0, bytesSinceDictionary: 0,
    loads: new Map(), seededLoads: false, archived: 0
  };
  tokens.forEach((text, index) => { if (!state.index.has(text)) state.index.set(text, index); state.bytes += Buffer.byteLength(text); });
  if (latest && scope !== store.PLATFORM_SCOPE) {
    const archives = await store.listReplayArchives(scope, 500);
    state.archived = archives.length;
    if (latest.dictionary_version) {
      const loaded = await readDictionary(scope, latest.generation, latest.dictionary_version);
      state.dictionary = loaded?.dictionary || null;
      state.dictionaryStored = loaded?.stored || 0;
      // Live bytes archived with that dictionary since it was built.
      state.bytesSinceDictionary = archives.filter((archive) => archive.org_generation === latest.generation && archive.org_version >= latest.dictionary_version)
        .reduce((sum, archive) => sum + archive.bytes_live, 0);
    }
  }
  return state;
}

const maxTokens = (state: ScopeState, settings: ArchiveSettings) => state.scope === store.PLATFORM_SCOPE ? settings.maxPlatformTokens : settings.maxOrgTokens;

function admit(state: ScopeState, text: string, settings: ArchiveSettings) {
  if (state.index.has(text) || state.pendingSet.has(text) || state.pending.length >= maxTokens(state, settings)) return;
  state.pending.push(text);
  state.pendingSet.add(text);
}

/** Whether a scope should write a version now: soon while it is young, then in batches (at most hourly for a few tokens). */
function versionDue(state: ScopeState, settings: ArchiveSettings, now: number) {
  if (!state.pending.length) return false;
  if (state.version === 0 || state.pending.length >= settings.versionBatchTokens) return true;
  if (state.scope !== store.PLATFORM_SCOPE && state.archived < settings.youngSessions) return true;
  return now - state.versionAt >= settings.versionEveryMs;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type ArchiveSessionReport = {
  id: string;
  organization_id: string;
  started_at: number;
  pages: number;
  pages_verbatim: number;
  chunks: number;
  bytes_live: number;
  bytes_json: number;
  bytes_archive: number;
  ratio: number;
  platform: string;
  vocabulary: string;
  dictionary_bytes: number;
  known_strings: number;
  status: "archived" | "dry_run" | "changed" | "failed" | "too_large" | "empty";
  error?: string;
  verbatim_reasons?: string[];
};

export type ArchiveReport = {
  id: string;
  dry_run: boolean;
  started_at: number;
  finished_at: number;
  older_than_ms: number;
  settings: Pick<ArchiveSettings, "orgMinSessions" | "platformMinOrgs" | "dictionaryBytes" | "dictionaryEvery">;
  skipped?: string;
  sessions: ArchiveSessionReport[];
  vocabulary: {
    platform_versions: number; platform_tokens_added: number; org_versions: number; org_tokens_added: number;
    dictionaries: number; token_bytes: number; dictionary_bytes: number;
  };
  totals: {
    sessions: number; bytes_live: number; bytes_archive: number; bytes_vocabulary: number;
    ratio_archives: number; ratio_with_vocabulary: number;
  };
};

export type ArchiveOptions = {
  dryRun?: boolean;
  olderThanMs?: number;
  sessionIds?: string[];
  organizationId?: string;
  limit?: number;
  now?: number;
  settings?: Partial<ArchiveSettings>;
  /** Tests: called before a session commits (to simulate a late chunk). */
  beforeCommit?: (sessionId: string) => Promise<void>;
};

const ratio = (live: number, stored: number) => stored > 0 ? Math.round((live / stored) * 100) / 100 : 0;

/**
 * Archives finished sessions, oldest first. With `dryRun` nothing is written except the run's report:
 * vocabulary versions and statistics are kept in memory, so the report shows what a real run would store.
 */
export async function runReplayArchive(options: ArchiveOptions = {}): Promise<ArchiveReport> {
  const settings = { ...archiveSettings(), ...options.settings };
  const dryRun = options.dryRun === true;
  const now = options.now ?? Date.now();
  const olderThanMs = options.olderThanMs ?? settings.afterMs;
  const id = randomUUID();
  const owner = `${process.pid}:${id}`;
  const report: ArchiveReport = {
    id, dry_run: dryRun, started_at: Date.now(), finished_at: 0, older_than_ms: olderThanMs,
    settings: { orgMinSessions: settings.orgMinSessions, platformMinOrgs: settings.platformMinOrgs, dictionaryBytes: settings.dictionaryBytes, dictionaryEvery: settings.dictionaryEvery },
    sessions: [],
    vocabulary: { platform_versions: 0, platform_tokens_added: 0, org_versions: 0, org_tokens_added: 0, dictionaries: 0, token_bytes: 0, dictionary_bytes: 0 },
    totals: { sessions: 0, bytes_live: 0, bytes_archive: 0, bytes_vocabulary: 0, ratio_archives: 0, ratio_with_vocabulary: 0 }
  };
  if (!dryRun && !(await store.acquireArchiveLock(owner, LOCK_MS))) {
    return { ...report, skipped: "another archive run is in progress", finished_at: Date.now() };
  }
  try {
    const candidates = await store.listArchiveCandidates({
      before: now - olderThanMs, limit: options.limit ?? settings.limit, sessionIds: options.sessionIds, organizationId: options.organizationId
    });
    const platform = await loadScope(store.PLATFORM_SCOPE);
    const orgs = new Map<string, ScopeState>();
    // A dry run keeps its statistics in memory on top of what is stored.
    const dryCounts = new Map<string, Map<string, number>>();
    const dryOrgsPerHash = new Map<string, Set<string>>();
    // A dry run's platform versions exist only here: each version's token list, by "generation.version".
    const platformLists = new Map<string, string[]>([[`${platform.generation}.${platform.version}`, platform.tokens.slice()]]);
    let lastLock = Date.now();

    /** Writes a scope's pending tokens (and for an organization, optionally a new dictionary) as its next version. */
    const writeVersion = async (state: ScopeState, withDictionary: boolean) => {
      const organization = state.scope !== store.PLATFORM_SCOPE;
      const added = state.pending.slice();
      const addedBytes = added.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
      // A full generation (tokens, bytes or versions) gives way to a fresh one; counts persist, so strings
      // still in use come straight back when next seen.
      const rollover = state.generation > 0 && (state.tokens.length + added.length > maxTokens(state, settings)
        || state.bytes + addedBytes > settings.maxTokenBytes || state.version >= settings.maxVersions);
      const generation = rollover ? state.generation + 1 : state.generation || 1;
      const version = rollover ? 1 : state.version + 1;
      const tokens = rollover ? added : [...state.tokens, ...added];
      const platformPin = organization ? { generation: platform.generation, version: platform.version } : { generation: 0, version: 0 };
      const dictionary = organization && withDictionary
        ? await buildDictionary(state, codec.combineVocabularies(platform.tokens, tokens), settings) : null;
      const inherited = organization && !rollover && !dictionary ? state.dictionaryVersion : 0;
      const tokensBlob = zstd(Buffer.from(JSON.stringify(added), "utf8"));
      const dictionaryBlob = dictionary ? zstd(dictionary) : Buffer.alloc(0);
      const row = {
        scope: state.scope, generation, version, token_count: tokens.length, tokens_added: added.length, token_bytes: addedBytes,
        dictionary_version: dictionary ? version : inherited, dictionary_bytes: dictionaryBlob.length, dictionary_sha256: dictionary ? codec.sha256(dictionary) : "",
        platform_generation: platformPin.generation, platform_version: platformPin.version, sessions: state.archived, created_at: Date.now()
      };
      if (!dryRun && !(await store.insertVocabVersion({ ...row, tokens: tokensBlob, dictionary: dictionaryBlob }))) {
        throw new Error(`Session replay vocabulary ${state.scope} ${generation}.${version} was written by another run.`);
      }
      state.pending = [];
      state.pendingSet.clear();
      if (rollover) { state.tokens = []; state.index = new Map(); state.bytes = 0; }
      for (const text of added) { if (!state.index.has(text)) state.index.set(text, state.tokens.length); state.tokens.push(text); state.bytes += Buffer.byteLength(text); }
      Object.assign(state, { generation, version, versionAt: row.created_at, platform: platformPin, dictionaryVersion: row.dictionary_version });
      if (dictionary) { state.dictionary = dictionary; state.dictionaryStored = dictionaryBlob.length; state.bytesSinceDictionary = 0; report.vocabulary.dictionaries++; }
      else if (rollover) { state.dictionary = null; state.dictionaryStored = 0; }
      report.vocabulary.token_bytes += tokensBlob.length;
      report.vocabulary.dictionary_bytes += dictionaryBlob.length;
      if (organization) { report.vocabulary.org_versions++; report.vocabulary.org_tokens_added += added.length; }
      else { report.vocabulary.platform_versions++; report.vocabulary.platform_tokens_added += added.length; platformLists.set(`${generation}.${version}`, state.tokens.slice()); }
    };

    for (const session of candidates) {
      if (!dryRun && Date.now() - lastLock > 60_000) {
        if (!(await store.acquireArchiveLock(owner, LOCK_MS))) throw new Error("Session replay archive lock lost.");
        lastLock = Date.now();
      }
      const row: ArchiveSessionReport = {
        id: session.id, organization_id: session.organization_id, started_at: session.started_at, pages: 0, pages_verbatim: 0, chunks: 0,
        bytes_live: session.bytes_stored, bytes_json: 0, bytes_archive: 0, ratio: 0, platform: "", vocabulary: "", dictionary_bytes: 0,
        known_strings: 0, status: "failed"
      };
      report.sessions.push(row);
      if (session.bytes_stored > settings.maxSessionBytes) { row.status = "too_large"; continue; }
      try {
        const source = await store.readReplaySource(session.id);
        row.chunks = source.chunks;
        row.bytes_live = source.bytesLive;
        if (!source.pages.length) { row.status = "empty"; continue; }
        const orgId = session.organization_id;
        let org = orgs.get(orgId);
        if (!org) { org = await loadScope(orgId); orgs.set(orgId, org); }

        // 1. Statistics, this session included (stored only once it is archived).
        const strings = new Set<string>();
        for (const page of source.pages) for (const text of codec.pageStrings(page.chunks)) if (text.length <= settings.orgTokenChars) strings.add(text);
        const list = [...strings];
        const hashes = list.map(hashOf);
        const stored = await store.readStringCounts(orgId, hashes);
        const overlay = dryCounts.get(orgId) || new Map<string, number>();
        const counts = hashes.map((hash) => (stored.get(hash) || 0) + (overlay.get(hash) || 0) + 1);
        const firstSeen = hashes.filter((_, index) => counts[index] === 1);
        // An organization count changes only when this organization sees a string for the first time.
        const orgsPer = firstSeen.length ? await store.organizationsPerString(firstSeen) : new Map<string, number>();
        list.forEach((text, index) => {
          if (counts[index] !== 1 || text.length > settings.platformTokenChars) return;
          const hash = hashes[index] ?? "";
          const total = (orgsPer.get(hash) || 0) + (dryOrgsPerHash.get(hash)?.size || 0) + 1;
          if (total >= settings.platformMinOrgs) admit(platform, text, settings);
        });
        list.forEach((text, index) => {
          if ((counts[index] ?? 0) >= settings.orgMinSessions && !platform.index.has(text) && !platform.pendingSet.has(text)) admit(org!, text, settings);
        });

        // 2. Versions: the platform's tokens, then this organization's tokens and, when due, its dictionary.
        if (versionDue(platform, settings, now)) await writeVersion(platform, false);
        const hasHistory = org.archived > 0 || org.loads.size > 0;
        const dictionaryDue = hasHistory && (!org.dictionary
          || org.bytesSinceDictionary >= Math.max(settings.dictionaryMinBytes, settings.dictionaryEvery * org.dictionaryStored));
        const platformMoved = org.platform.generation !== platform.generation || org.platform.version !== platform.version;
        if (dictionaryDue || versionDue(org, settings, now) || (org.version === 0 && platform.version > 0)
          || (platformMoved && org.version > 0 && now - org.versionAt >= settings.versionEveryMs)) {
          await writeVersion(org, dictionaryDue);
        }

        // 3. The archive, decoded with the vocabulary and dictionary as stored and compared with every chunk.
        const platformPin = org.version ? org.platform : { generation: platform.generation, version: platform.version };
        const orgPin = { generation: org.generation, version: org.version };
        const pinned: Pinned = dryRun
          ? { vocabulary: codec.combineVocabularies(platformLists.get(`${platformPin.generation}.${platformPin.version}`)
              ?? await readTokens(store.PLATFORM_SCOPE, platformPin.generation, platformPin.version), org.tokens), dictionary: org.dictionary }
          : await pinnedVocabulary(orgId, platformPin, orgPin);
        row.known_strings = list.length ? Math.round((list.filter((text) => pinned.vocabulary.idOf(text) !== undefined).length / list.length) * 1000) / 1000 : 0;
        const pages: codec.ArchivedPage[] = [];
        const reasons = new Set<string>();
        for (const page of source.pages) {
          const result = codec.archivePage(page.page_id, page.chunks.map((chunk) => ({ seq: chunk.seq, json: chunk.json })), pinned.vocabulary);
          if (!result.canonical) { row.pages_verbatim++; if (result.reason) reasons.add(result.reason); }
          pages.push(result.page);
        }
        const json = codec.serializeArchive({ f: codec.ARCHIVE_FORMAT, p: pages });
        const packed = codec.compressArchive(json, pinned.dictionary);
        verifyArchive(packed, pinned, source.pages);
        Object.assign(row, {
          pages: pages.length, bytes_json: json.length, bytes_archive: packed.length, ratio: ratio(row.bytes_live, packed.length),
          platform: `${platformPin.generation}.${platformPin.version}`, vocabulary: `${orgPin.generation}.${orgPin.version}`,
          dictionary_bytes: pinned.dictionary?.length || 0, ...(reasons.size ? { verbatim_reasons: [...reasons].slice(0, 5) } : {})
        });
        if (dryRun) row.status = "dry_run";
        else {
          await options.beforeCommit?.(session.id);
          row.status = await store.commitReplayArchive({
            session_id: session.id, organization_id: orgId, format: codec.ARCHIVE_FORMAT,
            platform_generation: platformPin.generation, platform_version: platformPin.version, org_generation: orgPin.generation, org_version: orgPin.version,
            pages: pages.length, pages_verbatim: row.pages_verbatim, chunks: source.chunks, bytes_live: source.bytesLive, bytes_json: json.length,
            bytes_archive: packed.length, json_sha256: codec.sha256(json), created_at: Date.now(), data: packed,
            expect_chunks: source.chunks, expect_max_received: source.maxReceived
          });
        }
        if (row.status === "archived" || row.status === "dry_run") {
          if (dryRun) {
            for (const hash of hashes) overlay.set(hash, (overlay.get(hash) || 0) + 1);
            dryCounts.set(orgId, overlay);
            for (const hash of firstSeen) { const set = dryOrgsPerHash.get(hash) || new Set<string>(); set.add(orgId); dryOrgsPerHash.set(hash, set); }
          } else await store.addStringCounts(orgId, hashes, session.last_at || now);
          org.bytesSinceDictionary += source.bytesLive;
          org.archived++;
          for (const page of source.pages) rememberLoad(org, page, settings);
        }
      } catch (error) {
        row.status = "failed";
        row.error = String(error instanceof Error ? error.message : error).slice(0, 500);
      }
    }
    // Tokens still pending are written now so the next run starts with them.
    if (platform.pending.length) await writeVersion(platform, false).catch(() => undefined);
    if (!dryRun) for (const orgId of orgs.keys()) await store.pruneStringCounts(orgId, now - STATS_STALE_MS, STATS_KEEP_ROWS).catch(() => 0);
  } finally {
    const done = report.sessions.filter((row) => row.status === "archived" || row.status === "dry_run");
    const live = done.reduce((sum, row) => sum + row.bytes_live, 0);
    const archived = done.reduce((sum, row) => sum + row.bytes_archive, 0);
    const vocabulary = report.vocabulary.token_bytes + report.vocabulary.dictionary_bytes;
    report.totals = { sessions: done.length, bytes_live: live, bytes_archive: archived, bytes_vocabulary: vocabulary,
      ratio_archives: ratio(live, archived), ratio_with_vocabulary: ratio(live, archived + vocabulary) };
    report.finished_at = Date.now();
    await store.recordArchiveRun({ id, dry_run: dryRun, started_at: report.started_at, finished_at: report.finished_at, sessions: done.length,
      bytes_live: live, bytes_archive: archived + vocabulary, report }).catch(() => undefined);
    if (!dryRun) await store.releaseArchiveLock(owner).catch(() => undefined);
  }
  return report;
}

/** The scheduled job (platform worker): archive what has been quiet for the configured number of days. */
export async function runScheduledReplayArchive() {
  if (String(process.env.SESSION_REPLAY_ARCHIVE || "").toLowerCase() === "off") return null;
  const report = await runReplayArchive();
  return { sessions: report.totals.sessions, skipped: report.skipped || "", failed: report.sessions.filter((row) => row.status === "failed").length };
}

const addressOf = (url: string) => url.replace(/[?#].*$/, "");

/** Keeps the load (first `dictionaryLoadMs`) of a page as the newest for its address. */
function rememberLoad(org: ScopeState, page: store.SourcePage, settings: ArchiveSettings) {
  const chunks = page.chunks.filter((chunk) => chunk.t_end - page.started_at <= settings.dictionaryLoadMs);
  if (!chunks.length) return;
  const key = addressOf(page.url) || page.page_id;
  org.loads.delete(key);
  org.loads.set(key, { ...page, chunks });
  while (org.loads.size > settings.dictionaryAddresses) org.loads.delete(org.loads.keys().next().value as string);
}

/**
 * The organization's dictionary: the newest load of each page address, canonical with the version's
 * vocabulary and with literal text blanked, newest last, up to `dictionaryBytes`.
 */
async function buildDictionary(org: ScopeState, vocabulary: codec.ArchiveVocabulary, settings: ArchiveSettings) {
  if (!org.seededLoads) {
    org.seededLoads = true;
    // Loads from sessions archived by earlier runs, under this run's newer ones.
    const recent = (await store.listReplayArchives(org.scope, settings.dictionarySessions)).reverse();
    const fromThisRun = [...org.loads.values()];
    org.loads.clear();
    for (const archive of recent) {
      try { for (const page of await restoredSessionPages(archive.session_id)) rememberLoad(org, page, settings); }
      catch { /* an unreadable archive contributes nothing */ }
    }
    for (const page of fromThisRun) rememberLoad(org, page, settings);
  }
  const pieces: Buffer[] = [];
  let total = 0;
  for (const page of [...org.loads.values()].reverse()) {
    const piece = codec.dictionaryPiece(codec.archivePage(page.page_id, page.chunks.map((chunk) => ({ seq: chunk.seq, json: chunk.json })), vocabulary).page);
    if (!piece) continue;
    const bytes = Buffer.from(piece, "utf8");
    if (total + bytes.length > settings.dictionaryBytes) {
      if (!pieces.length) pieces.push(bytes.subarray(0, settings.dictionaryBytes));
      break;
    }
    pieces.push(bytes);
    total += bytes.length;
  }
  return pieces.length ? Buffer.concat(pieces.reverse()) : null;
}

function verifyArchive(packed: Buffer, pinned: Pinned, pages: store.SourcePage[]) {
  const archive = codec.decompressArchive(packed, pinned.dictionary);
  if (archive.p.length !== pages.length) throw new Error("Archive verification failed: page count differs.");
  archive.p.forEach((page, index) => {
    const original = pages[index];
    if (!original || page.i !== original.page_id) throw new Error("Archive verification failed: page order differs.");
    const restored = codec.restorePage(page, pinned.vocabulary);
    if (restored.length !== original.chunks.length) throw new Error(`Archive verification failed: ${page.i} chunk count differs.`);
    restored.forEach((chunk, at) => {
      if (chunk.seq !== original.chunks[at]?.seq || chunk.json !== original.chunks[at]?.json) throw new Error(`Archive verification failed: ${page.i}/${chunk.seq} differs.`);
    });
  });
}

// ---------------------------------------------------------------------------
// Reading archived sessions
// ---------------------------------------------------------------------------

type Decoded = { at: number; pages: Map<string, Map<number, string>> };
const decodedCache = new Map<string, Promise<Decoded>>();

async function decodeSession(sessionId: string): Promise<Decoded> {
  const archive = await store.readReplayArchive(sessionId);
  if (!archive) throw new Error(`Session replay ${sessionId} has no archive.`);
  if (archive.format !== codec.ARCHIVE_FORMAT) throw new Error(`Session replay archive format ${archive.format} is not readable here.`);
  const pinned = await pinnedVocabulary(archive.organization_id,
    { generation: archive.platform_generation, version: archive.platform_version }, { generation: archive.org_generation, version: archive.org_version });
  const decoded = codec.decompressArchive(archive.data, pinned.dictionary);
  const pages = new Map<string, Map<number, string>>();
  for (const page of decoded.p) pages.set(page.i, new Map(codec.restorePage(page, pinned.vocabulary).map((chunk) => [chunk.seq, chunk.json])));
  return { at: Date.now(), pages };
}

async function decodedSession(sessionId: string) {
  const cached = decodedCache.get(sessionId);
  if (cached) {
    const value = await cached.catch(() => null);
    if (value && Date.now() - value.at < DECODED_TTL_MS) return value;
    decodedCache.delete(sessionId);
  }
  const loading = decodeSession(sessionId);
  decodedCache.set(sessionId, loading);
  loading.catch(() => decodedCache.delete(sessionId));
  while (decodedCache.size > DECODED_CACHE) decodedCache.delete(decodedCache.keys().next().value as string);
  return await loading;
}

/** The original chunk JSON of one page of an archived session, by sequence number. */
export async function readArchivedPageChunks(sessionId: string, pageId: string) {
  return (await decodedSession(sessionId)).pages.get(pageId) || new Map<number, string>();
}

/** Every page of an archived session as source pages (for building dictionaries). */
async function restoredSessionPages(sessionId: string): Promise<store.SourcePage[]> {
  const decoded = await decodedSession(sessionId);
  const detail = await store.readReplaySession(sessionId);
  const sizes = new Map((await store.readReplayChunkSizes(sessionId)).map((row) => [`${row.page_id}:${row.seq}`, row]));
  return (detail?.pages || []).filter((page) => decoded.pages.has(page.page_id)).map((page) => ({
    page_id: page.page_id, url: page.url, started_at: page.started_at,
    chunks: [...decoded.pages.get(page.page_id)!].map(([seq, json]) => {
      const size = sizes.get(`${page.page_id}:${seq}`);
      return { seq, json, bytes_stored: size?.bytes_stored || 0, received_at: 0, t_end: size?.t_end || 0 };
    })
  }));
}

/** Forget decoded sessions and vocabularies (tests, and after an organization is deleted). */
export function clearArchiveCaches() {
  decodedCache.clear();
  vocabularyCache.clear();
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

/** What the viewer's Storage panel shows: archive totals, vocabulary sizes and recent runs. */
export async function archiveOverview() {
  const [totals, platform, runs, versions] = await Promise.all([
    store.replayStorageTotals(), store.platformVocabularyTotals(), store.listArchiveRuns(10), store.listVocabVersions()
  ]);
  const archivedLive = totals.reduce((sum, row) => sum + row.archived_bytes_live, 0);
  const archived = totals.reduce((sum, row) => sum + row.archived_bytes, 0);
  const orgVocabulary = totals.reduce((sum, row) => sum + row.vocabulary_bytes, 0);
  const lastDryRun = runs.find((run) => run.dry_run);
  const scopes = new Map<string, { versions: number; generations: Set<number>; tokens: number; dictionaries: number; bytes: number }>();
  for (const version of versions) {
    const entry = scopes.get(version.scope) || { versions: 0, generations: new Set<number>(), tokens: 0, dictionaries: 0, bytes: 0 };
    entry.versions++; entry.generations.add(version.generation); entry.tokens = version.token_count;
    if (version.dictionary_version === version.version) entry.dictionaries++;
    entry.bytes += version.tokens_stored + version.dictionary_stored;
    scopes.set(version.scope, entry);
  }
  return {
    settings: archiveSettings(),
    platform_vocabulary: platform,
    archived: {
      bytes_live: archivedLive, bytes_archive: archived, bytes_vocabulary: orgVocabulary + platform.bytes,
      ratio_archives: ratio(archivedLive, archived), ratio_with_vocabulary: ratio(archivedLive, archived + orgVocabulary + platform.bytes)
    },
    vocabularies: [...scopes].map(([scope, entry]) => ({ scope, versions: entry.versions, generations: entry.generations.size, tokens: entry.tokens, dictionaries: entry.dictionaries, bytes: entry.bytes })),
    last_dry_run: lastDryRun ? { id: lastDryRun.id, started_at: lastDryRun.started_at, sessions: lastDryRun.sessions, totals: (lastDryRun.report as { totals?: unknown }).totals } : null,
    runs: runs.map((run) => ({ id: run.id, dry_run: run.dry_run, started_at: run.started_at, finished_at: run.finished_at, sessions: run.sessions,
      totals: (run.report as { totals?: unknown }).totals, skipped: (run.report as { skipped?: string }).skipped || "" }))
  };
}
