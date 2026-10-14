import { z } from "zod";
import { evaluateConditions, validateConditions } from "../work/conditions.js";
import { contentHash } from "../platform/publication/validation.js";
import type { Interval, Roster, RosterPerson } from "./roster.js";

/**
 * A staffing requirement is exactly a count and a condition: "at least `count` people on the work for whom `where`
 * holds". "At least one" is a count of 1. "This specific person" is a condition on the person's `id`. The condition is
 * the group form of the one condition contract (work/conditions.ts) over a roster person, so its fields are `id`,
 * `user_id`, `name`, `type_ids` (the person's access roles), `tag_ids`, `department_ids`, `group_ids` and
 * `fields.<custom field path>`. Nothing is a special field: what is true of a person is whatever field the
 * organization put on its people.
 *
 * "Requirements" alone means what a job needs done (docs/architecture/requirements.md); this is who has to be there.
 *
 * A staffing requirement sits on a group of users ("this group should always have a CDL driver", kept in the group's
 * base record) or on a piece of work (carried by the work and passed in). Both are checked against the whole effective
 * roster of the work, so adding someone to the work can meet a group's requirement. An unmet one is a warning. Nothing
 * here refuses a save.
 */
const field = z.string().max(300).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, "Use a dot path into the roster person.");
type Where = { match?: "all" | "any"; rules: Array<Where | { field: string; operator: string; value?: unknown }> };
const where: z.ZodType<Where> = z.lazy(() => z.object({
  match: z.enum(["all", "any"]).optional(),
  rules: z.array(z.union([where, z.object({ field, operator: z.string().max(40), value: z.unknown().optional() }).strict()])).min(1).max(16)
}).strict());
export const staffingRequirementSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/),
  /** What the people it counts are called, as a singular noun phrase: "CDL driver". Used in the reason given when it is unmet. */
  label: z.string().trim().min(1).max(120),
  count: z.number().int().min(1).max(500),
  where
}).strict().superRefine((value, context) => {
  for (const issue of validateConditions(value.where, "where")) context.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});
export type StaffingRequirement = z.infer<typeof staffingRequirementSchema>;
export const staffingRequirementListSchema = z.array(staffingRequirementSchema).max(50).superRefine((value, context) => {
  if (new Set(value.map((entry) => entry.id)).size !== value.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Each staffing requirement needs its own id." });
});

/** Where a staffing requirement came from: the work itself, or a group that is assigned to it. */
export type StaffingRequirementSource = { kind: "work" } | { kind: "assignee"; id: string; name: string };
export type SourcedStaffingRequirement = StaffingRequirement & { source: StaffingRequirementSource };

export type StaffingRequirementResult = {
  /** Stable for the same requirement, source and unmet intervals, so a scheduler can record that someone accepted it. */
  id: string;
  staffing_requirement_id: string; label: string; count: number; source: StaffingRequirementSource;
  met: boolean;
  /** The exact stretches of the window in which fewer than `count` matching people are on the work. */
  unmet: Array<Interval & { matching: number }>;
  /** People on the work who count toward it, at any time in the window. */
  matching_ids: string[];
  /** People who would count toward it but are not on the work for some of the window, and why. */
  missing: Array<{ id: string; name: string; reason: "unavailable" | "removed" | "not_assigned" | "inactive"; intervals: Interval[] }>;
  /** One plain sentence for a person. Empty when met. */
  reason: string;
};

/** What a condition sees for one person. */
export function personConditionContext(person: Pick<RosterPerson, "id" | "user_id" | "name" | "type_ids" | "tag_ids" | "department_ids" | "group_ids" | "fields">) {
  return { id: person.id, user_id: person.user_id, name: person.name, type_ids: person.type_ids, tag_ids: person.tag_ids, department_ids: person.department_ids, group_ids: person.group_ids, fields: person.fields };
}
export const personMatches = (requirement: Pick<StaffingRequirement, "where">, person: Parameters<typeof personConditionContext>[0], now?: string) =>
  evaluateConditions(requirement.where, personConditionContext(person), { payloadFallback: false, ...(now ? { now } : {}) });

const covers = (intervals: Interval[], from: number, until: number) => intervals.some((interval) => Date.parse(interval.from) <= from && Date.parse(interval.until) >= until);
const overlap = (intervals: Interval[], from: number, until: number): Interval[] => intervals
  .map((interval) => ({ from: Math.max(Date.parse(interval.from), from), until: Math.min(Date.parse(interval.until), until) }))
  .filter((interval) => interval.from < interval.until)
  .map((interval) => ({ from: new Date(interval.from).toISOString(), until: new Date(interval.until).toISOString() }));

function clock(instant: string, timezone: string, withDay: boolean) {
  const date = new Date(instant);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(date);
  return withDay ? `${new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).format(date)} ${time}` : time;
}
/** "8:00 AM-12:00 PM on Oct 14", or with a day on both ends when it runs past midnight. */
export function describeInterval(interval: Interval, timezone = "UTC") {
  const day = (instant: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).format(new Date(instant));
  // An interval that ends exactly at midnight ends on the day it started.
  const endDay = day(new Date(Date.parse(interval.until) - 1).toISOString());
  return day(interval.from) === endDay ? `${clock(interval.from, timezone, false)}-${clock(interval.until, timezone, false)} on ${endDay}` : `${clock(interval.from, timezone, true)}-${clock(interval.until, timezone, true)}`;
}
const plural = (label: string, count: number) => (count === 1 ? label : /(s|x|ch|sh)$/i.test(label) ? `${label}es` : `${label}s`);
const names = (list: string[]) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

/**
 * Checks staffing requirements against a resolved roster. One holds only if it holds at every moment of the window,
 * so each is counted over the roster's timeline and the exact stretches where it falls short are returned.
 */
export function evaluateStaffingRequirements(roster: Roster, requirements: SourcedStaffingRequirement[], options: { timezone?: string } = {}): StaffingRequirementResult[] {
  const timezone = options.timezone || "UTC";
  const assigned = names(roster.assigned.map((entry) => entry.name).filter(Boolean)) || "No one";
  return requirements.map((requirement): StaffingRequirementResult => {
    const matching = roster.people.filter((person) => personMatches(requirement, person, roster.window.from));
    const unmet = roster.timeline
      .map((segment) => ({ from: segment.from, until: segment.until, matching: matching.filter((person) => segment.person_ids.includes(person.id)).length }))
      .filter((segment) => segment.matching < requirement.count)
      // Neighbouring stretches that fall short by the same amount read as one.
      .reduce<Array<Interval & { matching: number }>>((merged, segment) => {
        const last = merged.at(-1);
        if (last && last.until === segment.from && last.matching === segment.matching) last.until = segment.until; else merged.push({ ...segment });
        return merged;
      }, []);
    const from = unmet.length ? Date.parse(unmet[0]!.from) : 0, until = unmet.length ? Date.parse(unmet.at(-1)!.until) : 0;
    // Who would have counted: people the assignment names who match but are off the work while it falls short.
    const missing = unmet.length ? [
      ...matching.filter((person) => !covers(person.present, from, until)).map((person) => ({
        id: person.id, name: person.name,
        reason: (overlap(person.unavailable, from, until).length ? "unavailable" : overlap(person.removed, from, until).length ? "removed" : "not_assigned") as StaffingRequirementResult["missing"][number]["reason"],
        intervals: overlap(person.unavailable, from, until).length ? overlap(person.unavailable, from, until) : overlap(person.removed, from, until)
      })),
      ...roster.absent.filter((person) => personMatches(requirement, person, roster.window.from)).map((person) => ({
        id: person.id, name: person.name, reason: person.reason,
        intervals: overlap(person.reason === "unavailable" ? person.unavailable : person.removed, from, until)
      }))
    ] : [];
    const source = requirement.source.kind === "assignee" ? requirement.source.name : "";
    const need = `${requirement.count} ${plural(requirement.label, requirement.count)}`;
    const subject = `${assigned} ${roster.assigned.length > 1 ? "are" : "is"} assigned`;
    const when = unmet.length ? names(unmet.map((interval) => describeInterval(interval, timezone))) : "";
    const wholeWindow = unmet.length === 1 && unmet[0]!.from === roster.window.from && unmet[0]!.until === roster.window.until;
    let reason = "";
    if (unmet.length) {
      const off = missing.filter((entry) => entry.reason === "unavailable");
      const removed = missing.filter((entry) => entry.reason === "removed");
      const known = matching.length + roster.absent.filter((person) => personMatches(requirement, person, roster.window.from)).length;
      if (!known) reason = `${subject}, but no one on the work is a ${requirement.label}${source ? ` (${source} needs ${need})` : ` (it needs ${need})`}.`;
      else if (off.length) {
        const only = known === 1 ? "only " : "";
        const whose = roster.assigned.length === 1 ? "its" : "the";
        reason = `${subject}, but ${whose} ${only}${plural(requirement.label, off.length)} (${names(off.map((entry) => entry.name))}) ${off.length > 1 ? "are" : "is"} off ${names(off.flatMap((entry) => entry.intervals).map((interval) => describeInterval(interval, timezone))) || when}.`;
      } else if (removed.length) reason = `${subject}, but ${names(removed.map((entry) => entry.name))} ${removed.length > 1 ? "were" : "was"} taken off the work, leaving ${Math.min(...unmet.map((interval) => interval.matching))} of the ${need} needed${wholeWindow ? "" : ` ${when}`}.`;
      else reason = `${subject}, but only ${Math.min(...unmet.map((interval) => interval.matching))} of the ${need} needed ${Math.min(...unmet.map((interval) => interval.matching)) === 1 ? "is" : "are"} on the work${wholeWindow ? "" : ` ${when}`}.`;
    }
    return {
      id: `staffing-requirement:${contentHash([requirement.source, requirement.id, unmet.map((interval) => [interval.from, interval.until])]).slice(0, 24)}`,
      staffing_requirement_id: requirement.id, label: requirement.label, count: requirement.count, source: requirement.source,
      met: !unmet.length, unmet, matching_ids: matching.map((person) => person.id), missing, reason
    };
  });
}
