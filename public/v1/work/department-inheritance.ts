/** Snapshot responsibility when a scope starts or its template is explicitly pushed.
 * Omission inherits; an explicit empty array intentionally keeps a stage shared.
 * Projects themselves never acquire department ownership.
 */
export function inheritWorkDepartments<T extends Record<string, any>>(nodes: T[], inherited: unknown = []): T[] {
  const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(String).map(id => id.trim()).filter(Boolean))] : [];
  return nodes.map(node => {
    const departments = node.department_ids === undefined ? ids(inherited) : ids(node.department_ids);
    return { ...node, department_ids: departments, ...(Array.isArray(node.children) ? { children: inheritWorkDepartments(node.children, departments) } : {}) };
  });
}
