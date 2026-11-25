import { describe, expect, it } from "vitest";
import {
  evaluatePhase,
  formatProjectMarkdown,
  LABELS,
  parseReport,
  phaseFingerprint,
  projectOutcome,
  renderPhaseSection,
  renderSummaryTable,
  UPSTREAM_SHA,
  type Decision,
  type Phase,
  type Report,
} from "../../src/typespec-breaking-change-demo/policy.ts";

function report(): Report {
  return {
    schemaVersion: 1,
    upstreamSha: UPSTREAM_SHA,
    baseSha: "a".repeat(40),
    baseTip: "a".repeat(40),
    headSha: "b".repeat(40),
    failures: [],
    projects: [
      {
        path: "specification/contosowidgetmanager/data-plane/BreakingChangeDemo",
        findings: [
          {
            kind: "ResponsePropertyRemoved",
            phase: "cross-version",
            severity: "error",
            suppressed: false,
            message: "City removed.",
            element: "body.properties.city",
            versionPair: { baseVersion: "2026-01-01", headVersion: "2026-06-01" },
          },
        ],
        approvals: [],
        comparisons: [],
        markdown: "",
      },
    ],
  };
}

describe("TypeSpec demo approval policy", () => {
  it("classifies outcomes and renders icons that follow applied labels", () => {
    const clean = report();
    clean.projects[0].findings = [];
    const failed = evaluatePhase(report(), "cross-version", false, false);
    const approved = evaluatePhase(report(), "cross-version", false, true);
    const none = evaluatePhase(clean, "cross-version", false, false);
    expect([failed.outcome, approved.outcome, none.outcome]).toEqual([
      "failed",
      "approved",
      "clean",
    ]);

    const decisions = new Map<Phase, Decision>([
      ["same-version", evaluatePhase(report(), "same-version", false, false)],
      ["cross-version", failed],
    ]);
    const summary = renderSummaryTable(decisions);
    expect(summary).toContain(`| ⚪ | ${LABELS["same-version"].check} |`);
    expect(summary).toContain(`| ❌ | ${LABELS["cross-version"].check} |`);
    expect(projectOutcome(report().projects[0], decisions)).toBe("failed");

    const bugfix = LABELS["cross-version"].bugfix;
    const unlabeled = renderPhaseSection("cross-version", failed, new Set());
    expect(unlabeled).toMatch(/^## ❌ /);
    expect(unlabeled).toContain(`⬜ Bugfix exception: \`${bugfix}\``);
    const labeled = renderPhaseSection("cross-version", approved, new Set([bugfix]));
    expect(labeled).toMatch(/^## ✅ /);
    expect(labeled).toContain(`✅ Bugfix exception: \`${bugfix}\``);
    expect(labeled).toContain("**applied**");
    decisions.set("cross-version", approved);
    expect(projectOutcome(report().projects[0], decisions)).toBe("approved");
  });

  it("regular approval cannot override an undecorated finding, but bugfix can", () => {
    expect(evaluatePhase(report(), "cross-version", true, false).state).toBe("failure");
    expect(evaluatePhase(report(), "cross-version", false, true).state).toBe("success");
  });

  it("a new matching decorator requires reviewer approval", () => {
    const value = report();
    value.projects[0].findings[0].suppressed = true;
    value.projects[0].findings[0].suppressionClassification = "new";
    value.projects[0].approvals.push({
      classification: "new",
      head: {
        decorator: "approvedBreakingChange",
        anchorIdentity: "Contoso.Widget.city",
        reason: "Intentional fixture removal.",
      },
    });
    expect(evaluatePhase(value, "cross-version", false, false).state).toBe("failure");
    expect(evaluatePhase(value, "cross-version", true, false).state).toBe("success");
  });

  it("an unchanged existing approval needs no new label", () => {
    const value = report();
    value.projects[0].findings[0].suppressed = true;
    value.projects[0].findings[0].suppressionClassification = "existing";
    expect(evaluatePhase(value, "cross-version", false, false).state).toBe("success");
  });

  it("uses source inventory rather than projection-duplicated finding classifications", () => {
    const value = report();
    value.projects[0].findings[0].suppressed = true;
    value.projects[0].findings[0].suppressionClassification = "new";
    value.projects[0].approvals.push({
      classification: "existing",
      head: {
        decorator: "approvedBreakingChange",
        anchorIdentity: "Contoso.Widget.city",
        reason: "Previously reviewed removal.",
      },
    });
    expect(evaluatePhase(value, "cross-version", false, false).state).toBe("success");
  });

  it("does not allow approval to hide partial suppression or another project's failure", () => {
    const value = report();
    value.projects.push(structuredClone(value.projects[0]));
    value.projects[0].findings[0].suppressed = true;
    expect(evaluatePhase(value, "cross-version", true, false).state).toBe("failure");
  });

  it("neither label overrides a compile or provenance failure", () => {
    const value = report();
    value.failures.push({ path: value.projects[0].path, message: "Compile error." });
    expect(evaluatePhase(value, "cross-version", true, true).state).toBe("failure");
    value.failures = [];
    value.upstreamSha = "0".repeat(40);
    expect(evaluatePhase(value, "cross-version", true, true).state).toBe("failure");
  });

  it("keeps phase gates independent", () => {
    expect(evaluatePhase(report(), "same-version", false, false).state).toBe("success");
    expect(LABELS["same-version"].bugfix).not.toBe(LABELS["cross-version"].bugfix);
  });

  it("uses a single exception label for changes to existing API versions", () => {
    const value = report();
    value.projects[0].findings[0].phase = "same-version";
    expect(LABELS["same-version"].approved).toBeUndefined();
    expect(LABELS["same-version"].bugfix).toBe("TypeSpec-UnversionedChange-Approved");
    expect(evaluatePhase(value, "same-version", false, false).state).toBe("failure");
    expect(evaluatePhase(value, "same-version", false, true).state).toBe("success");
  });

  it("formats upstream project markdown for nesting in the PR comment", () => {
    const path = "specification/contoso/data-plane/Widget";
    const markdown = [
      "",
      `### ${path}`,
      "",
      "No breaking changes found (2 version pairs compared)",
      "",
      "2 version pairs compared",
      "",
      "### New Breaking Changes",
      "",
      "#### 2026-01-01 → 2026-06-01",
      "",
      "| Kind | Source declaration | Wire identity | Source | Suppression |",
    ].join("\n");
    expect(formatProjectMarkdown(markdown, path)).toBe(
      [
        "No breaking changes found (2 version pairs compared)",
        "",
        "##### New Breaking Changes",
        "",
        "###### 2026-01-01 → 2026-06-01",
        "",
        "| Kind | Source declaration | Wire identity | Source | Suggested Fix |",
      ].join("\n"),
    );
  });

  it("requires review of new and modified decorators even when they match no finding", () => {
    const value = report();
    value.projects[0].findings = [];
    value.projects[0].approvals.push({
      classification: "modified",
      head: {
        decorator: "approvedBreakingChange",
        reason: "Changed justification.",
        anchorIdentity: "Contoso.Widget.city",
      },
    });
    expect(evaluatePhase(value, "cross-version", false, false).state).toBe("failure");
    expect(evaluatePhase(value, "cross-version", true, false).state).toBe("success");
  });

  it("binds approvals to findings and justification, not commit SHA or line numbers", () => {
    const value = report();
    const fingerprint = phaseFingerprint(value, "cross-version");
    value.headSha = "c".repeat(40);
    value.projects[0].findings[0].location = { file: "models.tsp", line: 42 };
    expect(phaseFingerprint(value, "cross-version")).toBe(fingerprint);
    value.projects[0].findings[0].suppressionReason = "Different reason.";
    expect(phaseFingerprint(value, "cross-version")).not.toBe(fingerprint);
  });

  it("rejects malformed or wrong-revision artifacts instead of treating them as empty", () => {
    expect(parseReport(JSON.stringify(report()))).toEqual(report());
    expect(() => parseReport("{}")).toThrow("Invalid report");
    const value = report();
    value.upstreamSha = "0".repeat(40);
    expect(() => parseReport(JSON.stringify(value))).toThrow("Invalid report");
    expect(() => parseReport('{"projects":[]}')).toThrow();
  });
});
