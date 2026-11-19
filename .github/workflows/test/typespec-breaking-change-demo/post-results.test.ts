import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  createMockContext,
  createMockCore,
  createMockGithub,
  createMockRequestError,
} from "../mocks.ts";
import postResults, {
  readCommentState,
} from "../../src/typespec-breaking-change-demo/post-results.ts";
import {
  COMMENT_MARKER,
  LABELS,
  phaseFingerprint,
  UPSTREAM_SHA,
  type Report,
} from "../../src/typespec-breaking-change-demo/policy.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue("mock-artifact-directory"),
  writeFile: vi.fn(),
  rm: vi.fn(),
}));

describe("demo result publication", () => {
  const head = "b".repeat(40);
  const base = "a".repeat(40);
  const run = {
    id: 12,
    run_attempt: 1,
    head_sha: head,
    status: "completed",
    html_url: "https://example.com/run/12",
  };
  let github: ReturnType<typeof createMockGithub>;
  let context: ReturnType<typeof createMockContext>;
  let core: ReturnType<typeof createMockCore>;
  let report: Report;
  let pull: {
    state: string;
    labels: { name: string }[];
    head: { sha: string; ref: string; repo: { full_name: string } };
    base: { ref: string; sha: string };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    github = createMockGithub();
    context = createMockContext();
    core = createMockCore();
    context.repo.owner = "catalinaperalta";
    context.repo.repo = "azure-rest-api-specs";
    context.eventName = "pull_request_target";
    context.actor = "reviewer";
    context.payload = { action: "opened", pull_request: { number: 42 } };
    pull = {
      state: "open",
      labels: [],
      head: {
        sha: head,
        ref: "demo/scenario",
        repo: { full_name: "catalinaperalta/azure-rest-api-specs" },
      },
      base: { ref: "demo/typespec-bc-20261118-base", sha: base },
    };
    github.rest.pulls.get.mockResolvedValue({ data: pull });
    github.rest.actions.listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [run] } });
    github.rest.repos.getContent.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve({
        data: {
          type: "file",
          content: Buffer.from(
            path.endsWith("typespec-breaking-change.yaml")
              ? "enabled: true"
              : `global-approvers: [reviewer]\n${LABELS["cross-version"].bugfix}: {}\n${LABELS["cross-version"].approved}: {}\n`,
          ).toString("base64"),
        },
      }),
    );
    github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
      data: {
        artifacts: [
          { id: 7, name: "typespec-breaking-change-demo", expired: false, size_in_bytes: 200 },
        ],
      },
    });
    report = {
      schemaVersion: 1,
      upstreamSha: UPSTREAM_SHA,
      baseSha: base,
      baseTip: base,
      headSha: head,
      failures: [],
      projects: [
        {
          path: "specification/contosowidgetmanager/data-plane/BreakingChangeDemo",
          approvals: [],
          comparisons: [],
          markdown: "Raw finding",
          findings: [
            {
              kind: "ResponsePropertyRemoved",
              severity: "error",
              phase: "cross-version",
              suppressed: false,
              message: "City removed.",
              versionPair: { baseVersion: "2026-01-01", headVersion: "2026-06-01" },
            },
          ],
        },
      ],
    };
    vi.mocked(execFileSync).mockImplementation(() => JSON.stringify(report));
  });

  async function publish(label?: string, permission = "write") {
    if (label) {
      context.payload.action = "labeled";
      context.payload.label = { name: label };
      pull.labels = [{ name: label }];
      if (permission === "read") {
        github.rest.repos.getContent.mockImplementation(({ path }: { path: string }) =>
          Promise.resolve({
            data: {
              type: "file",
              content: Buffer.from(
                path.endsWith("typespec-breaking-change.yaml")
                  ? "enabled: true"
                  : `global-approvers: []\n${label}: {}\n`,
              ).toString("base64"),
            },
          }),
        );
      }
    }
    await postResults({ github, context, core });
  }

  it("publishes independent statuses and a single combined comment", async () => {
    await publish();
    expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: head,
        context: LABELS["cross-version"].check,
        state: "failure",
      }),
    );
    expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: head,
        context: LABELS["same-version"].check,
        state: "success",
      }),
    );
    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(github.rest.actions.listWorkflowRuns).toHaveBeenCalledTimes(1);
  });

  it("accepts authorized bugfix approval without a decorator", async () => {
    await publish(LABELS["cross-version"].bugfix);
    expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ context: LABELS["cross-version"].check, state: "success" }),
    );
  });

  it("uses enabled configuration on any trusted base and accepts fork-head analysis", async () => {
    pull.base.ref = "main";
    pull.head.repo.full_name = "contributor/azure-rest-api-specs";
    await publish();
    expect(github.rest.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".github/typespec-breaking-change.yaml", ref: base }),
    );
    expect(github.rest.repos.createCommitStatus).toHaveBeenCalledTimes(2);
  });

  it("does not enable the checks on an unrelated base", async () => {
    github.rest.repos.getContent.mockResolvedValue({
      data: { type: "file", content: Buffer.from("enabled: false").toString("base64") },
    });
    await publish();
    expect(github.rest.actions.listWorkflowRuns).not.toHaveBeenCalled();
    expect(github.rest.repos.createCommitStatus).not.toHaveBeenCalled();
  });

  it("does not accept regular approval without a matching decorator", async () => {
    await publish(LABELS["cross-version"].approved);
    expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ context: LABELS["cross-version"].check, state: "failure" }),
    );
  });

  it("removes an unauthorized approval and preserves the failing gate", async () => {
    await publish(LABELS["cross-version"].bugfix, "read");
    expect(github.rest.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: LABELS["cross-version"].bugfix }),
    );
    expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ context: LABELS["cross-version"].check, state: "failure" }),
    );
  });

  it.each(["active", "inaccessible"])(
    "checks protected-label team membership: %s",
    async (membership) => {
      const label = LABELS["cross-version"].bugfix;
      github.rest.repos.getContent.mockImplementation(({ path }: { path: string }) =>
        Promise.resolve({
          data: {
            type: "file",
            content: Buffer.from(
              path.endsWith("typespec-breaking-change.yaml")
                ? "enabled: true"
                : `global-approvers: []\n${label}:\n  team: arm-breaking-change-reviewers\n`,
            ).toString("base64"),
          },
        }),
      );
      if (membership === "active") {
        github.rest.teams.getMembershipForUserInOrg.mockResolvedValue({
          data: { state: "active" },
        });
      } else {
        github.rest.teams.getMembershipForUserInOrg.mockRejectedValue(createMockRequestError(404));
      }
      await publish(label);
      expect(github.rest.teams.getMembershipForUserInOrg).toHaveBeenCalledWith(
        expect.objectContaining({
          username: "reviewer",
          team_slug: "arm-breaking-change-reviewers",
        }),
      );
      expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          context: LABELS["cross-version"].check,
          state: membership === "active" ? "success" : "failure",
        }),
      );
    },
  );

  it("preserves semantic approval across commits, but invalidates it after retargeting", async () => {
    const label = LABELS["cross-version"].bugfix;
    const state = {
      approvals: { "cross-version": { bugfix: phaseFingerprint(report, "cross-version") } },
      baseRef: pull.base.ref,
    };
    github.rest.issues.listComments.mockResolvedValue({
      data: [
        {
          id: 9,
          user: { type: "Bot" },
          body: `${COMMENT_MARKER}\n<!-- typespec-bc-demo-state:${Buffer.from(JSON.stringify(state)).toString("base64")} -->`,
        },
      ],
    });
    pull.labels = [{ name: label }];
    pull.head.sha = "c".repeat(40);
    report.headSha = pull.head.sha;
    await publish();
    expect(github.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        context: LABELS["cross-version"].check,
        state: "success",
      }),
    );
    pull.base.ref = "another-base";
    await publish();
    expect(github.rest.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: label }),
    );
  });

  it("does not override malformed reports with bugfix approval", async () => {
    report.headSha = "c".repeat(40);
    await publish(LABELS["cross-version"].bugfix);
    for (const phase of ["same-version", "cross-version"] as const) {
      expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
        expect.objectContaining({ context: LABELS[phase].check, state: "failure" }),
      );
    }
  });

  it("ignores an older head or superseded run without posting statuses", async () => {
    context.eventName = "workflow_run";
    context.payload = {
      workflow_run: { id: 1, head_sha: "c".repeat(40), head_branch: "demo/scenario" },
    };
    github.rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue({
      data: [
        {
          number: 42,
          state: "open",
          head: {
            ref: "demo/scenario",
            repo: { full_name: "catalinaperalta/azure-rest-api-specs" },
          },
          base: { ref: "demo/typespec-bc-20261118-base" },
        },
      ],
    });
    await publish();
    expect(github.rest.repos.createCommitStatus).not.toHaveBeenCalled();
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("invalidates old fingerprints and updates the same bot comment", async () => {
    github.rest.issues.listComments.mockResolvedValue({
      data: [
        {
          id: 9,
          user: { type: "Bot" },
          body: `${COMMENT_MARKER}\n<!-- typespec-bc-demo-state:${Buffer.from(
            JSON.stringify({
              approvals: { "cross-version": { bugfix: "0".repeat(64) } },
            }),
          ).toString("base64")} -->`,
        },
      ],
    });
    pull.labels = [{ name: LABELS["cross-version"].bugfix }];
    await publish();
    expect(github.rest.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: LABELS["cross-version"].bugfix }),
    );
    expect(github.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    expect(github.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("rejects malformed saved approval state rather than restoring labels", () => {
    expect(readCommentState("No prior demo comment.")).toEqual({ approvals: {} });
    expect(() => readCommentState("<!-- typespec-bc-demo-state:e30= -->")).toThrow("invalid");
  });
});
