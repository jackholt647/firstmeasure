/** Audience sources are additive; department removal revokes only department-derived delivery. */
export function matchesDepartmentNotificationTarget(note: Record<string, unknown>, userId: string, roles: string[], departments: string[]) {
  const ids = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
  return note.broadcast === true || ids(note.target_user_ids).includes(userId)
    || ids(note.target_role_ids).some(id => roles.includes(id))
    || ids(note.target_department_ids).some(id => departments.includes(id));
}
