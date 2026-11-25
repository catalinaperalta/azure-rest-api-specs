import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { GitHubScriptArgs } from "../github.ts";
import {
  COMMENT_MARKER,
  evaluatePhase,
  formatProjectMarkdown,
  LABELS,
  OUTCOME_ICONS,
  parseReport,
  PHASES,
  projectOutcome,
  renderPhaseSection,
  renderSummaryTable,
  REPORT_NAME,
  type Phase,
} from "./policy.ts";

type ApprovalState = Partial<Record<Phase, { regular?: string; bugfix?: string }>>;
interface CommentState {
  approvals: ApprovalState;
  baseRef?: string;
}

interface DemoEvent {
  inputs?: { pull_number?: string; approval_label?: string };
  action?: string;
  pull_request?: { number: number };
  label?: { name: string };
  workflow_run?: { id: number; head_sha: string; head_branch: string; run_attempt?: number };
}

export function readCommentState(body: string): CommentState {
  const encoded = body.match(/<!-- typespec-bc-demo-state:([A-Za-z0-9+/=]+) -->\s*$/)?.[1];
  if (!encoded) return { approvals: {} };
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (!value || typeof value !== "object" || !("approvals" in value)) {
      throw new Error("Missing approval state.");
    }
    const approvals = value.approvals;
    if (!approvals || typeof approvals !== "object") throw new Error("Invalid approval state.");
    for (const phase of PHASES) {
      const approval = (approvals as ApprovalState)[phase];
      if (approval && Object.values(approval).some((entry) => !/^[a-f0-9]{64}$/.test(entry))) {
        throw new Error("Invalid approval fingerprint.");
      }
    }
    const baseRef =
      "baseRef" in value && typeof value.baseRef === "string" ? value.baseRef : undefined;
    return { approvals, ...(baseRef ? { baseRef } : {}) };
  } catch (error) {
    throw new Error("Existing demo comment state is invalid; refusing to reuse approvals.", {
      cause: error,
    });
  }
}

export default async function postResults({ github, context, core }: GitHubScriptArgs) {
  const { owner, repo } = context.repo;
  const payload = context.payload as DemoEvent;
  const runEvent = payload.workflow_run;
  let number = payload.pull_request?.number;
  if (context.eventName === "workflow_dispatch") {
    number = Number(payload.inputs?.pull_number);
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error("A valid PR number is required.");
  }
  if (!number && runEvent) {
    const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: runEvent.head_sha,
      per_page: 100,
    });
    const pull = data.find(
      (entry) => entry.state === "open" && entry.head.ref === runEvent.head_branch,
    );
    number = pull?.number;
  }
  if (!number) {
    core.info("No open demo PR is associated with this event.");
    return;
  }
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  async function loadPolicy(path: string): Promise<Record<string, unknown>> {
    const { data } = await github.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: pr.base.sha,
    });
    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      throw new Error(`Unable to load trusted policy: ${path}.`);
    }
    const parsed: unknown = parseYaml(Buffer.from(data.content, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid trusted policy: ${path}.`);
    }
    return parsed as Record<string, unknown>;
  }
  if (pr.state !== "open") {
    core.info("Ignoring closed PR.");
    return;
  }
  if (runEvent && runEvent.head_sha !== pr.head.sha) {
    core.info("Ignoring analysis for an older head commit.");
    return;
  }
  try {
    const config = await loadPolicy(".github/typespec-breaking-change.yaml");
    if (config.enabled !== true) {
      core.info("TypeSpec breaking-change checks are not enabled on this base.");
      return;
    }
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 404) {
      core.info("This base has no TypeSpec breaking-change configuration.");
      return;
    }
    throw error;
  }
  const labels = new Set(pr.labels.map((label) => label.name));
  const approvalLabel = payload.label?.name ?? payload.inputs?.approval_label;
  const knownApprovalLabels: string[] = PHASES.flatMap((phase) =>
    [LABELS[phase].approved, LABELS[phase].bugfix].filter((label) => label !== undefined),
  );
  let authorizedLabelEvent = false;
  if (
    ((context.eventName === "pull_request_target" && payload.action === "labeled") ||
      context.eventName === "workflow_dispatch") &&
    approvalLabel &&
    knownApprovalLabels.includes(approvalLabel)
  ) {
    const policy = await loadPolicy(".github/protected-labels.yml");
    const labelPolicy = policy[approvalLabel];
    if (!labelPolicy || typeof labelPolicy !== "object") {
      throw new Error(`Missing protected-label policy for ${approvalLabel}.`);
    }
    const group = labelPolicy as Record<string, unknown>;
    const users = group.users ?? [];
    const teams = group.teams ?? [];
    if (
      !Array.isArray(users) ||
      !users.every((user: unknown) => typeof user === "string") ||
      !Array.isArray(teams) ||
      !teams.every((team: unknown) => typeof team === "string") ||
      (group.team !== undefined && typeof group.team !== "string")
    )
      throw new Error("Invalid label approver list.");
    const globals = policy["global-approvers"];
    if (!Array.isArray(globals) || !globals.every((user: unknown) => typeof user === "string")) {
      throw new Error("Invalid global approver list.");
    }
    const actor = context.actor.toLowerCase();
    authorizedLabelEvent = [...globals, ...users].some((user) => user.toLowerCase() === actor);
    for (const team of [...teams, ...(group.team ? [group.team] : [])]) {
      if (authorizedLabelEvent) break;
      try {
        const { data: membership } = await github.rest.teams.getMembershipForUserInOrg({
          org: owner,
          team_slug: team,
          username: context.actor,
        });
        authorizedLabelEvent = membership.state === "active";
      } catch (error) {
        if (error instanceof Error && "status" in error && error.status === 404) {
          core.warning(`Could not verify ${context.actor} in ${owner}/${team}; refusing approval.`);
        } else {
          throw error;
        }
      }
    }
    if (!authorizedLabelEvent) {
      await github.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: number,
        name: approvalLabel,
      });
      labels.delete(approvalLabel);
      core.warning(`Removed ${approvalLabel}: actor does not have reviewer permissions.`);
    }
  }
  const { data: runs } = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: "typespec-breaking-change-demo.yaml",
    branch: pr.head.ref,
    head_sha: pr.head.sha,
    per_page: 10,
  });
  const run = runs.workflow_runs[0];
  if (runEvent && run && run.id !== runEvent.id) {
    core.info("Ignoring superseded run or run attempt.");
    return;
  }
  if (runEvent && run && run.run_attempt !== runEvent.run_attempt) {
    core.info("Ignoring an older run attempt.");
    return;
  }
  if (!run || run.status !== "completed") {
    for (const phase of PHASES) {
      await github.rest.repos.createCommitStatus({
        owner,
        repo,
        sha: pr.head.sha,
        context: LABELS[phase].check,
        state: "pending",
        description: "Waiting for analysis of the current head and base.",
      });
    }
    return;
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) => comment.user?.type === "Bot" && comment.body?.startsWith(COMMENT_MARKER),
  );
  const state = readCommentState(existing?.body ?? "");
  if (state.baseRef !== pr.base.ref) state.approvals = {};
  state.baseRef = pr.base.ref;
  const sections: string[] = [COMMENT_MARKER, "# TypeSpec compatibility analysis"];
  const pendingRemovals = new Set<string>();
  const pendingAdditions = new Set<string>();
  const decisions = new Map<Phase, ReturnType<typeof evaluatePhase>>();
  try {
    const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
      owner,
      repo,
      run_id: run.id,
      name: REPORT_NAME,
      per_page: 100,
    });
    const artifact = artifacts.find((entry) => entry.name === REPORT_NAME && !entry.expired);
    if (!artifact || artifact.size_in_bytes > 5_000_000) {
      throw new Error("Analysis report artifact is missing, expired, or too large.");
    }
    const archive = await github.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: artifact.id,
      archive_format: "zip",
    });
    const temp = await mkdtemp(join(tmpdir(), "typespec-bc-demo-"));
    let text: string;
    try {
      const file = join(temp, "report.zip");
      await writeFile(file, Buffer.from(archive.data as ArrayBuffer));
      text = execFileSync("unzip", ["-p", file, `${REPORT_NAME}.json`], {
        encoding: "utf8",
        maxBuffer: 5_000_000,
      });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    const report = parseReport(text);
    if (report.headSha !== pr.head.sha || report.baseTip !== pr.base.sha) {
      throw new Error("Report does not match the current PR head and target base.");
    }
    sections.push(`Analysis: ${run.html_url}\n\nPinned upstream: \`${report.upstreamSha}\``);
    for (const phase of PHASES) {
      const fingerprint = evaluatePhase(report, phase, false, false).fingerprint;
      const previous = state.approvals[phase] ?? {};
      const current: { regular?: string; bugfix?: string } = {};
      for (const [family, label] of [
        ["regular", LABELS[phase].approved],
        ["bugfix", LABELS[phase].bugfix],
      ] as const) {
        if (!label || !labels.has(label)) continue;
        if (authorizedLabelEvent && approvalLabel === label) {
          current[family] = fingerprint;
        } else if (previous[family] === fingerprint) {
          current[family] = fingerprint;
        } else {
          pendingRemovals.add(label);
        }
      }
      state.approvals[phase] = current;
      const decision = evaluatePhase(report, phase, !!current.regular, !!current.bugfix);
      decisions.set(phase, decision);
      const reviewLabel = LABELS[phase].review;
      if (decision.requiresReview && !labels.has(reviewLabel)) {
        pendingAdditions.add(reviewLabel);
      } else if (!decision.requiresReview && labels.has(reviewLabel)) {
        pendingRemovals.add(reviewLabel);
      }
    }
    const appliedLabels = new Set([...labels].filter((label) => !pendingRemovals.has(label)));
    sections.push(renderSummaryTable(decisions));
    for (const phase of PHASES) {
      sections.push(renderPhaseSection(phase, decisions.get(phase)!, appliedLabels));
    }
    for (const failure of report.failures) {
      sections.push(
        `**Analysis failure** in \`${failure.path}\`:\n\n\`\`\`text\n${failure.message.slice(0, 3000)}\n\`\`\``,
      );
    }
    if (report.projects.length > 0) sections.push("## Details by project");
    for (const project of report.projects) {
      sections.push(
        `<details>\n<summary>${OUTCOME_ICONS[projectOutcome(project, decisions)]} ${project.path}</summary>\n\n${formatProjectMarkdown(project.markdown, project.path).slice(0, 12000)}\n\n</details>`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.error(message);
    sections.push(
      `**Analysis failed. Approval labels cannot override this failure.**\n\n${message}`,
    );
    for (const phase of PHASES) {
      decisions.set(phase, {
        state: "failure",
        outcome: "failed",
        description: "Analysis/report failure; approvals cannot override.",
        requiresReview: false,
        fingerprint: "",
        errors: 0,
        approvals: 0,
      });
    }
    sections.push(renderSummaryTable(decisions));
  }
  const { data: live } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (live.head.sha !== pr.head.sha || live.base.sha !== pr.base.sha || live.state !== "open") {
    core.info("PR changed while reading the report; discarding stale publication.");
    return;
  }
  for (const name of pendingRemovals) {
    await github.rest.issues.removeLabel({ owner, repo, issue_number: number, name });
  }
  if (pendingAdditions.size > 0) {
    await github.rest.issues.addLabels({
      owner,
      repo,
      issue_number: number,
      labels: [...pendingAdditions],
    });
  }
  for (const phase of PHASES) {
    const decision = decisions.get(phase)!;
    await github.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: pr.head.sha,
      context: LABELS[phase].check,
      state: decision.state,
      description: decision.description.slice(0, 140),
      target_url: run.html_url,
    });
  }
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
  sections.push(`<!-- typespec-bc-demo-state:${encoded} -->`);
  const body = sections.join("\n\n");
  if (existing) {
    if (existing.body !== body) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    }
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: number, body });
  }
}
