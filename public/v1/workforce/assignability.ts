import type { JsonObject } from "../platform/storage.js";

export const ASSIGNABLE_SUBJECT_TYPES = [
  "organization_user",
  "resource_group",
  "organization_connection",
  "equipment_unit"
] as const;

export type AssignableSubjectType = typeof ASSIGNABLE_SUBJECT_TYPES[number];

export type AssignmentRule = {
  id: string;
  subject_types: AssignableSubjectType[];
  subject_ids: string[];
  role_ids: string[];
  group_kind_ids: string[];
  kind_ids: string[];
  assignment_tag_ids: string[];
  tag_match: "all" | "any";
  capability_scope_ids: string[];
};

export type AssignmentPolicy = {
  schema_version: 1;
  mode: "any";
  allow_unassigned: boolean;
  rules: AssignmentRule[];
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function cleanId(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function uniqueIds(value: unknown) {
  return [...new Set(asArray(value).map((entry) => cleanId(asObject(entry).id || entry)).filter(Boolean))];
}

function subjectType(value: unknown): AssignableSubjectType | "" {
  const type = cleanId(value);
  if (["user", "person", "people", "organization_user"].includes(type)) return "organization_user";
  if (["group", "resource_group", "team", "crew"].includes(type)) return "resource_group";
  if (["connection", "organization_connection", "subcontractor"].includes(type)) return "organization_connection";
  if (["equipment", "equipment_unit"].includes(type)) return "equipment_unit";
  return "";
}

function normalizedRule(value: unknown, index: number): AssignmentRule | null {
  const input = asObject(value);
  const subjectTypes = uniqueIds(input.subject_types || input.types || [input.subject_type || input.type])
    .map(subjectType)
    .filter((type): type is AssignableSubjectType => !!type);
  const rule: AssignmentRule = {
    id: cleanId(input.id) || `rule_${index + 1}`,
    subject_types: subjectTypes,
    subject_ids: uniqueIds(input.subject_ids || input.ids),
    role_ids: uniqueIds(input.role_ids || input.user_role_ids || input.person_kind_ids),
    group_kind_ids: uniqueIds(input.group_kind_ids || input.resource_group_kind_ids),
    kind_ids: uniqueIds(input.kind_ids),
    assignment_tag_ids: uniqueIds(input.assignment_tag_ids || input.tag_ids || input.tags),
    tag_match: cleanText(input.tag_match || input.tag_mode).toLowerCase() === "any" ? "any" : "all",
    capability_scope_ids: uniqueIds(input.capability_scope_ids || input.scope_template_ids || input.scope_ids)
  };
  return rule.subject_types.length
    || rule.subject_ids.length
    || rule.role_ids.length
    || rule.group_kind_ids.length
    || rule.kind_ids.length
    || rule.assignment_tag_ids.length
    || rule.capability_scope_ids.length
    ? rule
    : null;
}

export function defaultAssignmentPolicy(eventTypeIdValue: unknown): AssignmentPolicy {
  const eventTypeId = cleanId(eventTypeIdValue);
  if (eventTypeId === "sales_appointment" || eventTypeId === "sales_follow_up") {
    return {
      schema_version: 1,
      mode: "any",
      allow_unassigned: true,
      rules: [{
        id: "salespeople",
        subject_types: ["organization_user"],
        subject_ids: [],
        role_ids: ["sales_appointments"],
        group_kind_ids: [],
        kind_ids: [],
        assignment_tag_ids: [],
        tag_match: "all",
        capability_scope_ids: []
      }]
    };
  }
  if (eventTypeId === "project_work") {
    return {
      schema_version: 1,
      mode: "any",
      allow_unassigned: true,
      rules: [
        {
          id: "production_groups",
          subject_types: ["resource_group"],
          subject_ids: [],
          role_ids: [],
          group_kind_ids: ["crew"],
          kind_ids: [],
          assignment_tag_ids: [],
          tag_match: "all",
          capability_scope_ids: []
        },
        {
          id: "external_work_resources",
          subject_types: ["organization_connection"],
          subject_ids: [],
          role_ids: [],
          group_kind_ids: [],
          kind_ids: [],
          assignment_tag_ids: [],
          tag_match: "all",
          capability_scope_ids: []
        },
        {
          id: "field_people",
          subject_types: ["organization_user"],
          subject_ids: [],
          role_ids: ["crew_member", "repairman", "crew_foreman", "supervisor"],
          group_kind_ids: [],
          kind_ids: [],
          assignment_tag_ids: [],
          tag_match: "all",
          capability_scope_ids: []
        }
      ]
    };
  }
  return { schema_version: 1, mode: "any", allow_unassigned: true, rules: [] };
}

export function normalizeAssignmentPolicy(
  value: unknown,
  options: { eventTypeId?: unknown; legacyRoleIds?: unknown; allowUnassigned?: unknown } = {}
): AssignmentPolicy {
  const input = asObject(value);
  const hasExplicitRules = Object.prototype.hasOwnProperty.call(input, "rules")
    || Object.prototype.hasOwnProperty.call(input, "any_of")
    || Object.prototype.hasOwnProperty.call(input, "allow");
  const rawRules = asArray(input.rules || input.any_of || input.allow);
  let rules = rawRules.map(normalizedRule).filter((rule): rule is AssignmentRule => !!rule);
  if (!rules.length && !hasExplicitRules) {
    const legacyRoleIds = uniqueIds(options.legacyRoleIds);
    if (legacyRoleIds.length) {
      rules = [normalizedRule({
        id: "legacy_user_roles",
        subject_type: "organization_user",
        role_ids: legacyRoleIds
      }, 0)!];
    } else {
      rules = defaultAssignmentPolicy(options.eventTypeId).rules;
    }
  }
  const explicitAllowUnassigned = input.allow_unassigned ?? input.allowUnassigned ?? options.allowUnassigned;
  return {
    schema_version: 1,
    mode: "any",
    allow_unassigned: explicitAllowUnassigned === undefined
      ? defaultAssignmentPolicy(options.eventTypeId).allow_unassigned
      : explicitAllowUnassigned === true,
    rules
  };
}

export function assignmentPolicyForEventType(eventTypeValue: unknown, eventTypeIdValue: unknown = "") {
  const eventType = asObject(eventTypeValue);
  return normalizeAssignmentPolicy(eventType.assignment_policy || eventType.assignable_policy || eventType.assignability, {
    eventTypeId: eventTypeIdValue || eventType.id,
    legacyRoleIds: eventType.required_role_ids || eventType.allowed_role_ids || eventType.role_ids,
    allowUnassigned: eventType.allow_unassigned
  });
}

export function normalizeAssignableSubject(value: unknown): JsonObject {
  const input = asObject(value);
  const type = subjectType(input.subject_type || input.resource_kind || input.kind);
  const roleIds = uniqueIds(input.role_ids || input.access_role_ids || asObject(input.user).role_ids || asObject(input.user).access_role_ids || asObject(input.user).roles);
  const groupKindId = cleanId(input.group_kind_id || input.kind_id);
  return {
    ...input,
    subject_type: type,
    id: cleanId(input.id || input.resource_id || asObject(input.work_resource_ref).id),
    role_ids: roleIds,
    group_kind_id: groupKindId,
    kind_ids: uniqueIds([
      ...uniqueIds(input.kind_ids),
      ...roleIds,
      ...(groupKindId ? [groupKindId] : [])
    ]),
    assignment_tag_ids: uniqueIds(input.assignment_tag_ids || input.tag_ids || input.tags),
    capability_scope_ids: uniqueIds(input.capability_scope_ids || input.scope_template_ids || input.project_types)
  };
}

export function assignableMatchesRule(subjectValue: unknown, ruleValue: unknown) {
  const subject = normalizeAssignableSubject(subjectValue);
  const rule = normalizedRule(ruleValue, 0);
  if (!rule || !cleanText(subject.subject_type) || !cleanText(subject.id)) return false;
  if (rule.subject_types.length && !rule.subject_types.includes(subject.subject_type as AssignableSubjectType)) return false;
  if (rule.subject_ids.length && !rule.subject_ids.includes(cleanText(subject.id))) return false;
  if (rule.role_ids.length) {
    if (subject.subject_type !== "organization_user") return false;
    const roles = uniqueIds(subject.role_ids);
    if (!rule.role_ids.some((roleId) => roles.includes(roleId))) return false;
  }
  if (rule.group_kind_ids.length) {
    if (subject.subject_type !== "resource_group" || !rule.group_kind_ids.includes(cleanText(subject.group_kind_id))) return false;
  }
  if (rule.kind_ids.length) {
    const kinds = uniqueIds(subject.kind_ids);
    if (!rule.kind_ids.some((kindId) => kinds.includes(kindId))) return false;
  }
  if (rule.assignment_tag_ids.length) {
    const tags = uniqueIds(subject.assignment_tag_ids);
    const tagMatches = rule.assignment_tag_ids.map((tagId) => tags.includes(tagId));
    if (rule.tag_match === "any" ? !tagMatches.some(Boolean) : !tagMatches.every(Boolean)) return false;
  }
  if (rule.capability_scope_ids.length) {
    const scopes = uniqueIds(subject.capability_scope_ids);
    if (!rule.capability_scope_ids.every((scopeId) => scopes.includes(scopeId))) return false;
  }
  return true;
}

export function assignableMatchesPolicy(subjectValue: unknown, policyValue: unknown) {
  const policy = normalizeAssignmentPolicy(policyValue);
  return !policy.rules.length || policy.rules.some((rule) => assignableMatchesRule(subjectValue, rule));
}

export function filterAssignableSubjects(subjects: unknown, policyValue: unknown) {
  const policy = normalizeAssignmentPolicy(policyValue);
  return asArray(subjects).map(normalizeAssignableSubject)
    .filter((subject) => !policy.rules.length || policy.rules.some((rule) => assignableMatchesRule(subject, rule)));
}
