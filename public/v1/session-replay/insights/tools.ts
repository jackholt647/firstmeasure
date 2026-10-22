import { z } from "zod";

import { indexPendingReplaySessions, indexReplaySession } from "./jobs.js";
import * as query from "./query.js";

/**
 * The session replay search tools, described for a language model (docs/architecture/session-replay-search.md).
 * GET /v1/platform/session-replay/insights/tools returns GUIDE and TOOLS; POST .../insights/call runs one.
 * Tool inputs are validated here; every tool returns JSON sized for a context window.
 */
export const GUIDE = `You are analysing recorded user sessions of a web application (session replays). Recordings are too many to read,
so work top-down: replay_overview for the period, replay_screens to find the screen (a URL with ids removed; "tab" in the
product usually means one), replay_targets and replay_flows for what people click there and in what order, replay_next for
what follows one element, replay_friction for rage clicks, dead clicks, error messages and script errors. Then check
claims on real sessions: replay_find_sessions (by screen, by elements clicked, by problems, by text) with order "random"
for a fair sample, replay_session_timeline to read one, and replay_screen_at to see what was on screen at a moment.
Counts come from indexed sessions only (see index_coverage in the overview). Element and screen ids are stable across
sessions and organizations for the same UI. Times are ISO dates or epoch milliseconds; the default period is 90 days.
Quote session ids and seconds when you cite evidence so a person can open replay_link and watch it.`;

const filter = {
  org_id: z.string().max(120).optional(),
  from: z.union([z.string().max(40), z.number()]).optional(),
  to: z.union([z.string().max(40), z.number()]).optional()
};
const id = z.string().min(1).max(120);

type Tool = { name: string; description: string; input_schema: Record<string, unknown>; schema: z.ZodTypeAny; run: (input: any) => Promise<unknown> | unknown };
const FILTER_JSON = {
  org_id: { type: "string", description: "Only this organization. Omit for every organization." },
  from: { type: ["string", "number"], description: "Start of the period (ISO date or epoch ms). Default: 90 days ago." },
  to: { type: ["string", "number"], description: "End of the period. Default: now." }
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: { ...FILTER_JSON, ...properties }, required });

const TOOLS: Tool[] = [
  { name: "replay_overview", description: "Totals for a period: sessions, people, hours, clicks, friction counts, the most used screens, and how many recordings are indexed.",
    input_schema: obj({}), schema: z.object(filter).strict(), run: query.overview },
  { name: "replay_screens", description: "Screens (URL patterns with ids removed) by sessions and visits, with average time spent. Filter by words in the screen's title or URL.",
    input_schema: obj({ query: { type: "string" }, limit: { type: "number" } }), schema: z.object({ ...filter, query: z.string().max(200).optional(), limit: z.number().optional() }).strict(), run: query.screens },
  { name: "replay_targets", description: "Elements people click (buttons, links, tabs, fields), optionally on one screen, with clicks, sessions, dead and rage clicks, errors that followed, and what is usually clicked next. Sort by clicks, sessions, dead, rage or errors_after.",
    input_schema: obj({ screen_id: { type: "string" }, query: { type: "string", description: "Words in the element's label" }, role: { type: "string" }, sort: { type: "string", enum: ["clicks", "sessions", "dead", "rage", "errors_after"] }, limit: { type: "number" } }),
    schema: z.object({ ...filter, screen_id: id.optional(), query: z.string().max(200).optional(), role: z.string().max(40).optional(), sort: z.enum(["clicks", "sessions", "dead", "rage", "errors_after"]).optional(), limit: z.number().optional() }).strict(), run: query.targets },
  { name: "replay_target", description: "One element: its label, role and selector path, what clicking it usually did (navigated, opened a dialog, showed an error, changed the page, nothing), and the screens it is used on.",
    input_schema: obj({ target_id: { type: "string" } }, ["target_id"]), schema: z.object({ ...filter, target_id: id }).strict(), run: query.target },
  { name: "replay_next", description: "What people click right after (and right before) one element, with shares and average seconds between.",
    input_schema: obj({ target_id: { type: "string" }, screen_id: { type: "string" }, limit: { type: "number" } }, ["target_id"]),
    schema: z.object({ ...filter, target_id: id, screen_id: id.optional(), limit: z.number().optional() }).strict(), run: query.next },
  { name: "replay_flows", description: "The most common click sequences on a screen, from entering it or from one element, with how often and how long they take. '(entered the screen)' and '(left the screen)' mark the ends of a visit.",
    input_schema: obj({ screen_id: { type: "string" }, start_target_id: { type: "string" }, length: { type: "number", description: "Steps per path, 2-8 (default 4)" }, limit: { type: "number" } }, ["screen_id"]),
    schema: z.object({ ...filter, screen_id: id, start_target_id: id.optional(), length: z.number().optional(), limit: z.number().optional(), max_steps_scanned: z.number().optional() }).strict(), run: query.flows },
  { name: "replay_friction", description: "Where people struggle, overall or on one screen: rage clicks, dead clicks (nothing happened), clicks followed by errors, error messages shown on screen, and script errors, each with example moments.",
    input_schema: obj({ screen_id: { type: "string" }, limit: { type: "number" } }), schema: z.object({ ...filter, screen_id: id.optional(), limit: z.number().optional() }).strict(), run: query.friction },
  { name: "replay_find_sessions", description: "Sessions matching: a person (email words), a screen, elements clicked (all of target_ids, in that order if ordered), problems (has: rage, dead, ui_error, js_error, dialog, input), words that appeared on screen (text), a minimum length. order 'random' samples fairly; default is newest first.",
    input_schema: obj({ user: { type: "string" }, screen_id: { type: "string" }, target_ids: { type: "array", items: { type: "string" } }, ordered: { type: "boolean" }, has: { type: "array", items: { type: "string", enum: ["rage", "dead", "ui_error", "js_error", "dialog", "input"] } }, text: { type: "string" }, min_seconds: { type: "number" }, limit: { type: "number" }, order: { type: "string", enum: ["recent", "random"] } }),
    schema: z.object({ ...filter, user: z.string().max(200).optional(), screen_id: id.optional(), target_ids: z.array(id).max(10).optional(), ordered: z.boolean().optional(), has: z.array(z.enum(["rage", "dead", "ui_error", "js_error", "dialog", "input"])).optional(), text: z.string().max(300).optional(), min_seconds: z.number().optional(), limit: z.number().optional(), order: z.enum(["recent", "random"]).optional() }).strict(), run: query.findSessions },
  { name: "replay_search_text", description: "Sessions in which these words appeared on screen (headings, labels, dialogs, messages, page text), with a snippet.",
    input_schema: obj({ query: { type: "string" }, limit: { type: "number" } }, ["query"]), schema: z.object({ ...filter, query: z.string().min(1).max(300), limit: z.number().optional() }).strict(), run: query.searchText },
  { name: "replay_session_timeline", description: "One session as readable lines: screens opened, clicks and what each caused, field edits (never the values), keys, dialogs, error messages, idle time. Narrow with from_seconds/to_seconds or kinds.",
    input_schema: { type: "object", properties: { session_id: { type: "string" }, from_seconds: { type: "number" }, to_seconds: { type: "number" }, kinds: { type: "array", items: { type: "string" } }, limit: { type: "number" } }, required: ["session_id"] },
    schema: z.object({ session_id: id, from_seconds: z.number().optional(), to_seconds: z.number().optional(), kinds: z.array(z.string().max(20)).optional(), limit: z.number().optional() }).strict(), run: query.sessionTimeline },
  { name: "replay_screen_at", description: "What was on screen at a moment of a session (seconds from its start): URL, focused element, element under the pointer, headings and an outline of interactive elements and text with node ids (pass node_id to expand one part).",
    input_schema: { type: "object", properties: { session_id: { type: "string" }, seconds: { type: "number" }, max_lines: { type: "number" }, node_id: { type: "number" } }, required: ["session_id", "seconds"] },
    schema: z.object({ session_id: id, seconds: z.number(), max_lines: z.number().optional(), node_id: z.number().optional() }).strict(), run: query.screenAt },
  { name: "replay_link", description: "A link a person can open to watch the session.",
    input_schema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] }, schema: z.object({ session_id: id }).strict(), run: (input) => query.replayLink(input) },
  { name: "replay_recent_sessions", description: "The newest recordings, indexed or not.",
    input_schema: { type: "object", properties: { org_id: { type: "string" }, limit: { type: "number" } } }, schema: z.object({ org_id: z.string().max(120).optional(), limit: z.number().optional() }).strict(), run: query.recentSessions },
  { name: "replay_index_now", description: "Index one session now (session_id), or the sessions waiting to be indexed. Sessions are otherwise indexed about 10 minutes after they go quiet.",
    input_schema: { type: "object", properties: { session_id: { type: "string" } } }, schema: z.object({ session_id: id.optional() }).strict(),
    run: async (input) => input.session_id ? (await indexReplaySession(input.session_id)) || { error: "No recording with that id." } : await indexPendingReplaySessions({ quietMs: 0, limit: 50 }) }
];

export function toolManifest() {
  return { guide: GUIDE, tools: TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })) };
}

export async function callTool(name: string, input: unknown, context: { origin?: string } = {}) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { error: `Unknown tool ${name}. Known: ${TOOLS.map((t) => t.name).join(", ")}` };
  const parsed = tool.schema.safeParse(input ?? {});
  if (!parsed.success) return { error: "Invalid input: " + parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") };
  const value = name === "replay_link" ? query.replayLink({ ...(parsed.data as { session_id: string }), origin: context.origin }) : await tool.run(parsed.data);
  return value;
}
