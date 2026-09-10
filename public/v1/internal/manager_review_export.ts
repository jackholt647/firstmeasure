// Quote every field and neutralize spreadsheet formulas in user-supplied text.
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function managerReviewCsv(rows: Record<string, unknown>[]) {
  const header = ["Project ID", "Address", "Sample date", "Reviewed at", "QA name", "QA email", "Team", "Result", "Severity", "Issue types", "Notes", "Score exclusion"];
  const lines = rows.map(row => [
    row.project_id, row.address, row.sample_date, row.reviewed_at,
    row.qa_name, row.qa_email, row.team_name,
    row.audit_status === "flagged" ? "Issues found" : row.audit_status === "reviewed" ? "Passed" : "Open",
    row.severity, Array.isArray(row.issue_categories) ? row.issue_categories.join("; ") : "",
    row.note, row.score_exclusion_reason || (row.score_excluded ? "manual" : "")
  ]);
  return '\uFEFF' + [header, ...lines].map(line => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
