// Mirrors editor.php's blind-review contract. Applied before serializing a
// streamed PHP bundle, so PHP never materializes the potentially huge PDF state.
const identityKeys = new Set([
  'qa_claimed_by_email', 'qa_claimed_by_name', 'qa_approved_by_email', 'qa_approved_by_name', 'qa_approved_by',
  'qa_reviewed_by_email', 'qa_reviewed_by_name', 'qa_reviewed_by', 'qa_reviewer_email', 'qa_reviewer_name',
  'reviewer_email', 'reviewer_name', 'reviewed_by_email', 'reviewed_by_name', 'rejected_by_email', 'rejected_by_name',
  'reopened_by_email', 'reopened_by_name', 'previous_qa_approved_by', 'previous_qa_approved_by_name',
  'manager_audit_updated_by_email', 'manager_audit_updated_by_name', 'manager_audit_reviewed_by_email',
  'manager_audit_reviewed_by_name', 'manager_audit_flagged_by_email', 'manager_audit_flagged_by_name',
  'complexity_updated_by_email', 'complexity_updated_by_name'
]);
const historyKeys = new Set(['qa_email', 'qa_name', 'qa_reviewer_email', 'qa_reviewer_name', 'reviewer_email',
  'reviewer_name', 'reviewed_by_email', 'reviewed_by_name', 'inspector', 'inspector_name', 'by_email', 'by_name',
  'user_email', 'user_name', 'actor_email', 'actor_name']);

/** Mutates only a freshly-read response object; never writes stored records. */
export function blindEditorQaIdentity(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const child of value) blindEditorQaIdentity(child); return; }
  const node = value as Record<string, any>;
  const role = String(node.role ?? '').trim().toLowerCase();
  if (role === 'qa' || role === 'manager') {
    for (const key of ['by', 'by_email', 'email']) if (key in node) node[key] = null;
    for (const key of ['by_name', 'name']) if (key in node) node[key] = role === 'manager' ? 'Manager' : 'QA';
  }
  for (const key of identityKeys) if (key in node) node[key] = null;
  for (const key of ['work_history', 'qa_history', 'history']) {
    if (Array.isArray(node[key])) for (const event of node[key]) {
      if (event && typeof event === 'object') for (const field of historyKeys) if (field in event) event[field] = null;
    }
  }
  const claim = node.workflow?.qa_claim;
  if (claim && typeof claim === 'object') for (const key of ['email', 'name', 'id', 'claimed_by_email', 'claimed_by_name']) {
    if (key in claim) claim[key] = null;
  }
  for (const child of Object.values(node)) blindEditorQaIdentity(child);
}
