import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import {
  createProject,
  getProjectDetail,
  patchManifest,
  saveAppMetadata,
  saveArtifact
} from "../../firstmeasure/storage.js";
import { PDF_FILE_NAMES } from "../../firstmeasure/constants.js";
import { saveInternalDocument } from "../../internal/storage.js";

type Person = { email: string; name: string };

const qas: Person[] = [
  { email: "qa.alex@example.test", name: "Alex QA" },
  { email: "qa.blair@example.test", name: "Blair QA" },
  { email: "qa.casey@example.test", name: "Casey QA" },
  { email: "qa.devon@example.test", name: "Devon QA" }
];

const technicians: Person[] = [
  { email: "tech.avery@example.test", name: "Avery Technician" },
  { email: "tech.cameron@example.test", name: "Cameron Technician" },
  { email: "tech.drew@example.test", name: "Drew Technician" },
  { email: "tech.jordan@example.test", name: "Jordan Technician" },
  { email: "tech.morgan@example.test", name: "Morgan Technician" }
];

const reviewer = { email: "reviewer.professional@example.test", name: "Professional Reviewer" };
const projectTypes = ["residential", "commercial", "multifamily"];
const complexities = ["simple", "standard", "complex", "very_complex"];
const issueCategories = ["measurements", "geometry", "missing_content", "presentation", "coverage"];
const severities = ["minor", "moderate", "major"];

function sqlDate(date: Date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function demoPdf(sample: {
  address: string;
  projectType: string;
  complexity: string;
  index: number;
}) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
    const page = document.addPage([792, 612]);
    page.drawRectangle({ x: 0, y: 552, width: 792, height: 60, color: rgb(0.11, 0.2, 0.32) });
    page.drawText("DEMO MANAGER REVIEW SAMPLE", { x: 34, y: 578, size: 17, font: bold, color: rgb(1, 1, 1) });
    page.drawText(`Page ${pageNumber} of 3`, { x: 680, y: 580, size: 10, font: regular, color: rgb(0.85, 0.9, 0.96) });
    page.drawText(sample.address, { x: 40, y: 520, size: 18, font: bold, color: rgb(0.15, 0.18, 0.22) });
    page.drawText(`${sample.projectType.toUpperCase()}  |  ${sample.complexity.replaceAll("_", " ").toUpperCase()}`, { x: 40, y: 495, size: 11, font: regular, color: rgb(0.35, 0.39, 0.45) });
    const labels = pageNumber === 1
      ? ["Primary roof area", "Total eave", "Total ridge", "Waste factor"]
      : pageNumber === 2
        ? ["North elevation", "East elevation", "South elevation", "West elevation"]
        : ["Facet count", "Penetrations", "Accessories", "Reviewer notes"];
    labels.forEach((label, row) => {
      const y = 430 - row * 78;
      page.drawRectangle({ x: 40, y: y - 22, width: 712, height: 52, borderColor: rgb(0.78, 0.82, 0.87), borderWidth: 1, color: row % 2 ? rgb(0.98, 0.985, 0.99) : rgb(1, 1, 1) });
      page.drawText(label, { x: 56, y, size: 12, font: bold, color: rgb(0.2, 0.24, 0.3) });
      page.drawText(String(120 + sample.index * 7 + row * 13 + pageNumber), { x: 650, y, size: 14, font: bold, color: rgb(0.1, 0.42, 0.68) });
    });
    page.drawText("Synthetic data only — no employee identity is printed in this report.", { x: 40, y: 30, size: 9, font: regular, color: rgb(0.48, 0.52, 0.58) });
  }
  return document.save();
}

async function ensureProject(index: number) {
  const id = `mra_demo_${String(index + 1).padStart(2, "0")}`;
  const qa = qas[index % qas.length]!;
  const technician = technicians[(index * 2 + 1) % technicians.length]!;
  const projectType = projectTypes[index % projectTypes.length]!;
  const complexity = complexities[(index + Math.floor(index / 3)) % complexities.length]!;
  const address = `${100 + index} Demo Sample ${projectType === "commercial" ? "Plaza" : "Lane"}, Testville`;
  const completed = new Date(Date.now() - index * 1.65 * 864e5);
  const qaReviewed = new Date(completed.getTime() - 2.4 * 36e5);
  const audited = index % 4 !== 3;
  const flagged = audited && (index % 5 === 1 || index % 7 === 2);
  const qualityScore = !audited ? null : flagged ? Math.max(52, 88 - (index % 6) * 6) : 96 + (index % 5);
  const auditedAt = new Date(completed.getTime() + (index % 4 + 1) * 36e5);
  const issueCategory = flagged ? issueCategories[index % issueCategories.length] : null;
  const severity = flagged ? severities[index % severities.length] : null;
  const note = flagged ? `Synthetic ${issueCategory?.replaceAll("_", " ")} issue missed during QA.` : null;
  const auditStatus = !audited ? null : flagged ? "flagged" : "reviewed";
  const auditRecord = audited ? {
    schema_version: 1,
    project_id: id,
    status: auditStatus,
    outcome: flagged ? "issue" : "pass",
    quality_score: qualityScore,
    issue_category: issueCategory,
    severity,
    note,
    reviewed_at: auditedAt.toISOString(),
    reviewer_email: reviewer.email,
    reviewer_name: reviewer.name,
    reviewer_role: "professional_reviewer",
    annotation_pages: flagged ? 1 : 0,
    sample: {
      qa_email: qa.email,
      qa_name: qa.name,
      technician_email: technician.email,
      technician_name: technician.name,
      project_type: projectType,
      complexity,
      completed_at: sqlDate(completed),
      project_status: "completed"
    }
  } : null;

  try {
    await getProjectDetail(id);
  } catch {
    await createProject({ id, address, status: "completed", project_type: projectType, complexity, lat: 34.05 + index * 0.002, lng: -118.25 - index * 0.002 });
  }

  const qaEvent = {
    event: "qa_approved",
    ts: qaReviewed.toISOString(),
    qa_email: qa.email,
    qa_name: qa.name,
    worker_email: technician.email,
    worker_name: technician.name
  };
  const auditEvent = auditRecord ? {
    event: flagged ? "manager_audit_flagged" : "manager_audit_reviewed",
    ts: auditedAt.toISOString(),
    by_email: reviewer.email,
    by_name: reviewer.name,
    manager_audit_status: auditStatus,
    quality_score: qualityScore,
    issue_category: issueCategory,
    severity,
    note
  } : null;
  const annotations = flagged ? {
    "0": {
      strokes: [{ type: "text", x: 0.48, y: 0.35, text: "Synthetic missed issue", color: "#ef4444", size: 14 }],
      undoStack: [],
      redoStack: []
    }
  } : {};
  await patchManifest(id, {
    status: "completed",
    project_type: projectType,
    complexity,
    assigned_to_email: technician.email,
    assigned_to_name: technician.name,
    qa_reviewed_by: qa.email,
    qa_reviewed_by_name: qa.name,
    qa_reviewed_at: sqlDate(qaReviewed),
    qa_approved_by: qa.email,
    qa_approved_by_name: qa.name,
    qa_approved_at: sqlDate(qaReviewed),
    completed_at: sqlDate(completed),
    timestamps: { completed_at: sqlDate(completed), updated_at: audited ? auditedAt.toISOString() : completed.toISOString() },
    workflow: {
      assigned_to: technician,
      qa_claim: null,
      history: auditEvent ? [qaEvent, auditEvent] : [qaEvent]
    },
    work_history: auditEvent ? [qaEvent, auditEvent] : [qaEvent],
    manager_audit_status: auditStatus,
    manager_audit_note: note,
    manager_audit_quality_score: qualityScore,
    manager_audit_issue_category: issueCategory,
    manager_audit_severity: severity,
    manager_audit_updated_at: audited ? auditedAt.toISOString() : null,
    manager_audit_updated_by_email: audited ? reviewer.email : null,
    manager_audit_updated_by_name: audited ? reviewer.name : null,
    manager_audit_record: auditRecord,
    manager_audit_history: auditRecord ? [auditRecord] : [],
    manager_audit_annotations: annotations,
    audit: {
      manager_audit_status: auditStatus,
      manager_audit_note: note,
      manager_audit_quality_score: qualityScore,
      manager_audit_issue_category: issueCategory,
      manager_audit_severity: severity,
      manager_audit_updated_at: audited ? auditedAt.toISOString() : null,
      manager_audit_updated_by_email: audited ? reviewer.email : null,
      manager_audit_updated_by_name: audited ? reviewer.name : null,
      manager_audit_record: auditRecord,
      manager_audit_annotations: annotations
    }
  });
  await saveAppMetadata(id, {
    demo_manager_review_sample: true,
    manager_review_annotations: annotations,
    manager_review_annotations_meta: audited ? {
      updated_at: auditedAt.toISOString(),
      reviewer_email: reviewer.email,
      reviewer_name: reviewer.name
    } : null
  });
  await saveArtifact(id, PDF_FILE_NAMES.main, await demoPdf({ address, projectType, complexity, index }));
  if (auditRecord) {
    await saveInternalDocument("manager_audit", id, { data: { ...auditRecord, history: [auditRecord] } }, { replace: true });
  }
  return {
    id,
    audited,
    flagged,
    qualityScore,
    entry: {
      project_id: id,
      qa_email: qa.email,
      qa_name: qa.name,
      technician_email: technician.email,
      technician_name: technician.name,
      project_type: projectType,
      complexity,
      completed_at: sqlDate(completed),
      project_status: "completed"
    }
  };
}

const results = [];
for (let index = 0; index < 27; index += 1) results.push(await ensureProject(index));
const sampleDate = new Date().toISOString().slice(0, 10);
const priorSampleDateValue = new Date(`${sampleDate}T12:00:00.000Z`);
priorSampleDateValue.setUTCDate(priorSampleDateValue.getUTCDate() - 1);
const priorSampleDate = priorSampleDateValue.toISOString().slice(0, 10);
const now = new Date().toISOString();
const carryover = results.filter((item) => !item.audited).slice(0, 3);
const carryoverIds = new Set(carryover.map((item) => item.id));
const currentSample = results.filter((item) => !carryoverIds.has(item.id));
await saveInternalDocument("manager_review_config", "settings", { data: { daily_target: 24 } }, { replace: true });
await saveInternalDocument("manager_review_samples", priorSampleDate, {
  data: {
    schema_version: 1,
    sample_date: priorSampleDate,
    configured_target: 24,
    entries: carryover.map((item) => item.entry),
    created_at: now,
    updated_at: now
  }
}, { replace: true });
await saveInternalDocument("manager_review_samples", sampleDate, {
  data: {
    schema_version: 1,
    sample_date: sampleDate,
    configured_target: 24,
    entries: currentSample.map((item) => item.entry),
    created_at: now,
    updated_at: now
  }
}, { replace: true });
const auditedCount = results.filter((item) => item.audited).length;
const flaggedCount = results.filter((item) => item.flagged).length;
console.log(JSON.stringify({
  success: true,
  projects: results.length,
  audited: auditedCount,
  flagged: flaggedCount,
  unreviewed: results.length - auditedCount,
  daily_sample_date: sampleDate,
  daily_sample_target: 24,
  carried_over_from: priorSampleDate,
  carried_over: carryover.length,
  ids: results.map((item) => item.id)
}, null, 2));
