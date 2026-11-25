import { createHash } from "node:crypto";

export const UPSTREAM_SHA = "7f56fcca7fcf28734c6338c27f3fb5b747636215";
export const REPORT_NAME = "typespec-breaking-change-demo";
export const COMMENT_MARKER = "<!-- typespec-breaking-change-demo -->";
export const PHASES = ["same-version", "cross-version"] as const;
export type Phase = (typeof PHASES)[number];

export interface PhaseLabels {
  /** Regular approval of matching approval decorators; absent when the phase has no decorator path. */
  approved?: string;
  /** Exception approval that does not require approval decorators. */
  bugfix: string;
  review: string;
  check: string;
}

// Initial rollout: same-version changes have a single exception label and no decorator approval path.
export const LABELS: Record<Phase, PhaseLabels> = {
  "same-version": {
    bugfix: "TypeSpec-UnversionedChange-Approved",
    review: "TypeSpec-UnversionedChange-ReviewRequired",
    check: "TypeSpec Unversioned Breaking Change",
  },
  "cross-version": {
    approved: "TypeSpec-BreakingChange-Approved",
    bugfix: "TypeSpec-BreakingChange-Approved-BugFix",
    review: "TypeSpec-BreakingChange-ReviewRequired",
    check: "TypeSpec Versioned Breaking Change",
  },
};

export const PHASE_NAMES: Record<Phase, string> = {
  "same-version": "Same-version",
  "cross-version": "Cross-version",
};

/**
 * Adapts upstream per-project markdown for nesting inside the consolidated PR comment:
 * drops the repeated project heading, demotes headings below the comment's H2 sections,
 * removes redundant comparison counts, and clarifies the suggestion column.
 */
export function formatProjectMarkdown(markdown: string, projectPath: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    if (line.trim() === `### ${projectPath}`) continue;
    const previous = [...result].reverse().find((entry) => entry.trim() !== "");
    if (
      /^\d+ version pairs? compared$/.test(line.trim()) &&
      previous !== undefined &&
      /version pairs? compared\)/.test(previous)
    ) {
      continue;
    }
    const heading = /^(#{1,4}) (.*)$/.exec(line);
    if (heading) {
      result.push(`${"#".repeat(Math.min(heading[1].length + 2, 6))} ${heading[2]}`);
      continue;
    }
    result.push(line.replace(/\| Suppression \|$/, "| Suggested Fix |"));
  }
  return result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface Finding {
  kind: string;
  severity: string;
  phase: Phase;
  suppressed: boolean;
  suppressionReason?: string;
  suppressionClassification?: "new" | "existing" | "modified";
  message: string;
  element?: string;
  sourceElementPath?: string;
  operation?: { method: string; path: string };
  versionPair: { baseVersion: string; headVersion: string };
  location?: { file: string; line: number };
}

export interface ApprovalChange {
  classification: "new" | "existing" | "modified" | "removed";
  head?: {
    decorator: string;
    anchorIdentity: string;
    kind?: string;
    path?: string;
    since?: string;
    reason: string;
  };
}

export interface ProjectReport {
  path: string;
  findings: Finding[];
  approvals: ApprovalChange[];
  comparisons: {
    baseVersion: string;
    headVersion: string;
    phase: Phase;
  }[];
  markdown: string;
}

export interface Report {
  schemaVersion: 1;
  upstreamSha: string;
  baseSha: string;
  baseTip: string;
  headSha: string;
  projects: ProjectReport[];
  failures: { path: string; message: string }[];
}

export type Outcome = "failed" | "approved" | "clean";

export const OUTCOME_ICONS: Record<Outcome, string> = {
  failed: "❌",
  approved: "✅",
  clean: "⚪",
};

const OUTCOME_TEXT: Record<Outcome, string> = {
  failed: "Action required",
  approved: "Approved",
  clean: "No breaking changes",
};

export interface Decision {
  state: "success" | "failure";
  outcome: Outcome;
  description: string;
  fingerprint: string;
  requiresReview: boolean;
  errors: number;
  approvals: number;
}

export function phaseFingerprint(report: Report, phase: Phase): string {
  const content = report.projects
    .map((project) => ({
      path: project.path,
      findings: project.findings
        .filter((finding) => finding.phase === phase && finding.severity === "error")
        .map((finding) => ({
          kind: finding.kind,
          message: finding.message,
          suppressed: finding.suppressed,
          reason: finding.suppressionReason,
          element: finding.element,
          source: finding.sourceElementPath,
          operation: finding.operation,
          versions: finding.versionPair,
        })),
      approvals: changedApprovals(project, phase),
    }))
    .filter((project) => project.findings.length > 0 || project.approvals.length > 0);
  return createHash("sha256")
    .update(JSON.stringify({ upstream: report.upstreamSha, phase, content }))
    .digest("hex");
}

function changedApprovals(project: ProjectReport, phase: Phase): ApprovalChange[] {
  const decorator =
    phase === "same-version" ? "approvedUnversionedChange" : "approvedBreakingChange";
  return project.approvals
    .filter(
      (approval) =>
        (approval.classification === "new" || approval.classification === "modified") &&
        approval.head?.decorator === decorator,
    )
    .map((approval) => ({ classification: approval.classification, head: approval.head }));
}

export function evaluatePhase(
  report: Report,
  phase: Phase,
  approved: boolean,
  bugfix: boolean,
): Decision {
  const findings = report.projects.flatMap((project) =>
    project.findings.filter((finding) => finding.phase === phase && finding.severity === "error"),
  );
  const errors = findings.filter((finding) => !finding.suppressed).length;
  const approvals = report.projects.flatMap((project) => changedApprovals(project, phase)).length;
  const common = {
    fingerprint: phaseFingerprint(report, phase),
    requiresReview: errors + approvals > 0,
    errors,
    approvals,
  };
  if (report.failures.length > 0 || report.upstreamSha !== UPSTREAM_SHA) {
    return {
      ...common,
      state: "failure",
      outcome: "failed",
      description: "Analysis failed; approval cannot override.",
    };
  }
  if (common.requiresReview && bugfix) {
    return {
      ...common,
      requiresReview: false,
      state: "success",
      outcome: "approved",
      description:
        phase === "same-version"
          ? "Reviewer-approved exception for existing API versions."
          : "Reviewer-approved bugfix exception.",
    };
  }
  if (errors > 0) {
    return {
      ...common,
      state: "failure",
      outcome: "failed",
      description:
        phase === "same-version"
          ? `${errors} change(s) to existing API versions need to be reverted or approved.`
          : `${errors} finding(s) need matching decorators or bugfix approval.`,
    };
  }
  if (approvals > 0 && !approved) {
    return {
      ...common,
      state: "failure",
      outcome: "failed",
      description: "Approval decorators require reviewer approval.",
    };
  }
  return {
    ...common,
    requiresReview: false,
    state: "success",
    outcome: common.requiresReview ? "approved" : "clean",
    description: common.requiresReview
      ? "Matching decorators approved by reviewer."
      : "No new changes require approval.",
  };
}

function labelLine(role: string, label: string, detail: string, applied: boolean): string {
  return `- ${applied ? "✅" : "⬜"} ${role}: \`${label}\` (${detail})${applied ? " — **applied**" : ""}`;
}

/** Renders the summary table shown at the top of the PR comment. */
export function renderSummaryTable(decisions: ReadonlyMap<Phase, Decision>): string {
  const rows = PHASES.map((phase) => {
    const decision = decisions.get(phase)!;
    return `| ${OUTCOME_ICONS[decision.outcome]} | ${LABELS[phase].check} | ${OUTCOME_TEXT[decision.outcome]} | ${decision.description} |`;
  });
  return [
    "| | Check | Status | Details |",
    "| :-: | --- | --- | --- |",
    ...rows,
    "",
    `${OUTCOME_ICONS.failed} action required · ${OUTCOME_ICONS.approved} approved by reviewer label · ${OUTCOME_ICONS.clean} no breaking changes`,
  ].join("\n");
}

/** Renders one check section, including which approval labels are currently applied. */
export function renderPhaseSection(
  phase: Phase,
  decision: Decision,
  appliedLabels: ReadonlySet<string>,
): string {
  const labels = LABELS[phase];
  const lines = [
    `## ${OUTCOME_ICONS[decision.outcome]} ${labels.check}`,
    "",
    `**${OUTCOME_TEXT[decision.outcome]}**: ${decision.description}`,
    "",
  ];
  if (labels.approved) {
    lines.push(
      labelLine(
        "Regular approval",
        labels.approved,
        "matching `@approvedBreakingChange` decorators required",
        appliedLabels.has(labels.approved),
      ),
      labelLine(
        "Bugfix exception",
        labels.bugfix,
        "no decorator required",
        appliedLabels.has(labels.bugfix),
      ),
    );
  } else {
    lines.push(
      labelLine(
        "Exception approval",
        labels.bugfix,
        "no decorator required",
        appliedLabels.has(labels.bugfix),
      ),
    );
  }
  return lines.join("\n");
}

/** Picks a project icon from the phases in which the project has reviewable changes. */
export function projectOutcome(
  project: ProjectReport,
  decisions: ReadonlyMap<Phase, Decision>,
): Outcome {
  const phases = PHASES.filter(
    (phase) =>
      project.findings.some((finding) => finding.phase === phase && finding.severity === "error") ||
      changedApprovals(project, phase).length > 0,
  );
  if (phases.length === 0) return "clean";
  return phases.some((phase) => decisions.get(phase)?.state === "failure") ? "failed" : "approved";
}

export function parseReport(text: string): Report {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error("Report must be an object.");
  const report = value as Record<string, unknown>;
  if (
    report.schemaVersion !== 1 ||
    report.upstreamSha !== UPSTREAM_SHA ||
    ![report.baseSha, report.baseTip, report.headSha].every(
      (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
    ) ||
    !Array.isArray(report.projects) ||
    !Array.isArray(report.failures)
  ) {
    throw new Error("Invalid report provenance or schema.");
  }
  for (const project of report.projects as unknown[]) {
    if (
      !isRecord(project) ||
      typeof project.path !== "string" ||
      !project.path.startsWith("specification/") ||
      project.path.split("/").includes("..") ||
      !Array.isArray(project.findings) ||
      !Array.isArray(project.approvals) ||
      !Array.isArray(project.comparisons) ||
      typeof project.markdown !== "string"
    ) {
      throw new Error("Invalid project report.");
    }
    for (const finding of project.findings as unknown[]) {
      if (
        !isRecord(finding) ||
        (finding.phase !== "same-version" && finding.phase !== "cross-version") ||
        (finding.severity !== "error" && finding.severity !== "ignore") ||
        typeof finding.suppressed !== "boolean" ||
        typeof finding.kind !== "string" ||
        typeof finding.message !== "string" ||
        !isRecord(finding.versionPair) ||
        typeof finding.versionPair.baseVersion !== "string" ||
        typeof finding.versionPair.headVersion !== "string"
      ) {
        throw new Error("Invalid finding.");
      }
    }
    for (const approval of project.approvals as unknown[]) {
      if (
        !isRecord(approval) ||
        typeof approval.classification !== "string" ||
        !["new", "existing", "modified", "removed"].includes(approval.classification) ||
        (approval.classification !== "removed" &&
          (!isRecord(approval.head) ||
            typeof approval.head.reason !== "string" ||
            typeof approval.head.anchorIdentity !== "string" ||
            typeof approval.head.decorator !== "string" ||
            !["approvedBreakingChange", "approvedUnversionedChange"].includes(
              approval.head.decorator,
            )))
      ) {
        throw new Error("Invalid approval inventory.");
      }
    }
  }
  for (const failure of report.failures as unknown[]) {
    if (
      !isRecord(failure) ||
      typeof failure.path !== "string" ||
      typeof failure.message !== "string"
    ) {
      throw new Error("Invalid analysis failure.");
    }
  }
  return value as Report;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
