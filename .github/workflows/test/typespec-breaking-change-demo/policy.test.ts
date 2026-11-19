import { describe, expect, it } from "vitest";
import {
  evaluatePhase,
  LABELS,
  parseReport,
  phaseFingerprint,
  UPSTREAM_SHA,
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
  it("regular approval cannot override an undecorated finding, but bugfix can", () => {
    expect(evaluatePhase(report(), "cross-version", true, false).state).toBe("failure");
    expect(evaluatePhase(report(), "cross-version", false, true).state).toBe("success");
  });

  it("a new matching decorator requires reviewer approval", () => {
    const value = report();
    value.projects[0].findings[0].suppressed = true;
    value.projects[0].findings[0].suppressionClassification = "new";
    expect(evaluatePhase(value, "cross-version", false, false).state).toBe("failure");
    expect(evaluatePhase(value, "cross-version", true, false).state).toBe("success");
  });

  it("an unchanged existing approval needs no new label", () => {
    const value = report();
    value.projects[0].findings[0].suppressed = true;
    value.projects[0].findings[0].suppressionClassification = "existing";
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
