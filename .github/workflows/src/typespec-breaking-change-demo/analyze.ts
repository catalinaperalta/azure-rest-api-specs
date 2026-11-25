import { execFileSync } from "node:child_process";
import { appendFile, lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  findTypeSpecProjects,
  findTypeSpecProjectsInChangedServices,
} from "../../../shared/src/typespec-projects.ts";
import {
  evaluatePhase,
  formatProjectMarkdown,
  LABELS,
  OUTCOME_ICONS,
  PHASE_NAMES,
  PHASES,
  REPORT_NAME,
  UPSTREAM_SHA,
  type ApprovalChange,
  type Finding,
  type ProjectReport,
  type Report,
} from "./policy.ts";

interface Program {
  diagnostics: { severity: string; code: string; message: string }[];
}

interface Analysis {
  findings: { suppressionClassification?: Finding["suppressionClassification"] }[];
  suppressionComparison?: { classifications: ApprovalChange[] };
}

interface Upstream {
  compileService(path: string): Promise<Program>;
  enumerateVersions(program: Program): {
    service: { name: string };
    versions: string[];
  }[];
  analyzeBaseAndHead(base: Program, head: Program): Analysis;
  analyzeProgram(head: Program): Analysis;
  compareSuppressions(base: Program, head: Program): { classifications: ApprovalChange[] };
  buildSuppressionInventory(program: Program): unknown[];
  compareInventories(base: unknown[], head: unknown[]): { classifications: ApprovalChange[] };
  formatJsonReport(result: Analysis): string;
  renderMarkdownSummary(result: Analysis, options: Record<string, unknown>): string;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function linkToolchain(project: string, upstream: string): Promise<void> {
  const modules = join(project, "node_modules");
  await mkdir(modules, { recursive: true });
  for (const [scope, target] of [
    ["@typespec", join(upstream, "core", "packages")],
    ["@azure-tools", join(upstream, "packages")],
  ]) {
    const destination = join(modules, scope);
    if (!(await exists(destination))) {
      await symlink(target, destination, "junction");
    } else if ((await realpath(destination)) !== (await realpath(target))) {
      throw new Error(`Existing ${destination} does not resolve to the pinned upstream toolchain.`);
    }
  }
}

export async function analyze(
  root: string,
  upstream: string,
  base: string,
  output: string,
): Promise<Report> {
  if (git(upstream, "rev-parse", "HEAD") !== UPSTREAM_SHA) {
    throw new Error(`Upstream must be checked out at ${UPSTREAM_SHA}.`);
  }
  const report: Report = {
    schemaVersion: 1,
    upstreamSha: UPSTREAM_SHA,
    baseSha: git(root, "merge-base", base, "HEAD"),
    baseTip: git(root, "rev-parse", base),
    headSha: git(root, "rev-parse", "HEAD"),
    projects: [],
    failures: [],
  };
  const tool = (await import(
    pathToFileURL(join(upstream, "packages", "typespec-breaking-change", "dist", "src", "index.js"))
      .href
  )) as Upstream;
  const changed = git(root, "diff", "--name-only", report.baseSha, "HEAD")
    .split(/\r?\n/)
    .filter(Boolean);
  const coreChanged =
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `
    $ErrorActionPreference = 'Stop'
    . (Join-Path $env:TYPESPEC_REPO 'eng/scripts/ChangedFiles-Functions.ps1')
    $files = @(Get-ChangedFiles -baseCommitish $env:TYPESPEC_BASE -headCommitish HEAD -diffFilter '')
    [bool](@(Get-ChangedCoreFiles $files).Count) | ConvertTo-Json -Compress
  `,
      ],
      {
        cwd: root,
        env: { ...process.env, TYPESPEC_REPO: root, TYPESPEC_BASE: report.baseSha },
        encoding: "utf8",
      },
    ).trim() === "true";
  const touchedServices = [
    ...new Set(
      changed.flatMap((file) => /^specification\/[^/]+\//.exec(file)?.[0].slice(0, -1) ?? []),
    ),
  ];
  const discovered = coreChanged
    ? await findTypeSpecProjects(join(root, "specification"))
    : await findTypeSpecProjectsInChangedServices(root, changed);
  const projects = new Set(discovered.map((path) => relative(root, path).replaceAll("\\", "/")));
  const baseConfigs = git(
    root,
    "ls-tree",
    "-r",
    "--name-only",
    report.baseSha,
    "--",
    ...(coreChanged ? ["specification"] : touchedServices),
  )
    .split(/\r?\n/)
    .filter((path) => path.endsWith("/tspconfig.yaml"));
  const headConfigs = new Set(
    git(
      root,
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      "--",
      ...(coreChanged ? ["specification"] : touchedServices),
    ).split(/\r?\n/),
  );
  if (coreChanged || touchedServices.length > 0) {
    for (const config of baseConfigs) {
      if (!headConfigs.has(config)) projects.add(config.slice(0, -"/tspconfig.yaml".length));
    }
  }
  const checkoutTool = (await import(
    pathToFileURL(
      join(
        upstream,
        "packages",
        "typespec-breaking-change",
        "dist",
        "src",
        "cli",
        "git-checkout.js",
      ),
    ).href
  )) as {
    checkoutRevision: (
      ref: string,
      root: string,
      options: { sparsePaths: string[] },
    ) => Promise<{
      worktreePath: string;
      cleanup(): Promise<void>;
    }>;
  };
  const checkout =
    projects.size > 0
      ? await checkoutTool.checkoutRevision(report.baseSha, root, {
          sparsePaths: [
            ...(coreChanged ? ["specification"] : touchedServices),
            "specification/common-types",
            ".github",
            "eng",
            "libs",
          ],
        })
      : undefined;
  try {
    for (const project of [...projects].sort()) {
      try {
        const head = join(root, project);
        const before = join(checkout!.worktreePath, project);
        if (!(await exists(join(head, "main.tsp")))) {
          throw new Error(
            "Deleted or renamed project: upstream does not analyze missing head services.",
          );
        }
        await linkToolchain(head, upstream);
        const headProgram = await compile(head);
        let result: Analysis;
        let approvals: ApprovalChange[];
        if (await exists(join(before, "main.tsp"))) {
          await linkToolchain(before, upstream);
          const baseProgram = await compile(before);
          const headVersions = new Map(
            tool
              .enumerateVersions(headProgram)
              .map(({ service, versions }) => [service.name, new Set(versions)]),
          );
          for (const { service, versions } of tool.enumerateVersions(baseProgram)) {
            if (versions.some((version) => !headVersions.get(service.name)?.has(version))) {
              throw new Error("Service or API version removed: upstream coverage is unavailable.");
            }
          }
          // Version projections mutate decorator state; inventory must precede analysis.
          approvals = tool.compareSuppressions(baseProgram, headProgram).classifications;
          result = tool.analyzeBaseAndHead(baseProgram, headProgram);
        } else {
          approvals = tool.compareInventories(
            [],
            tool.buildSuppressionInventory(headProgram),
          ).classifications;
          result = tool.analyzeProgram(headProgram);
        }
        const json = JSON.parse(tool.formatJsonReport(result)) as {
          findings: Finding[];
          summary: { versionComparisons?: ProjectReport["comparisons"] };
        };
        report.projects.push({
          path: project,
          findings: json.findings.map((finding, index) => ({
            ...finding,
            suppressionClassification: result.findings[index]?.suppressionClassification,
            location: finding.location
              ? {
                  ...finding.location,
                  file: relative(root, finding.location.file).replaceAll("\\", "/"),
                }
              : undefined,
          })),
          approvals: approvals.map((approval) => ({
            classification: approval.classification,
            head: approval.head && {
              decorator: approval.head.decorator,
              anchorIdentity: approval.head.anchorIdentity,
              kind: approval.head.kind,
              path: approval.head.path,
              since: approval.head.since,
              reason: approval.head.reason,
            },
          })),
          comparisons: json.summary.versionComparisons ?? [],
          markdown: tool.renderMarkdownSummary(result, {
            specPaths: [project],
            workspacePath: root,
            githubRepository: process.env.GITHUB_REPOSITORY,
            githubSha: report.headSha,
            githubServerUrl: process.env.GITHUB_SERVER_URL,
            omitTitle: true,
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${project}: ${message}`);
        report.failures.push({ path: project, message });
      }
    }
  } finally {
    await checkout?.cleanup();
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, `${REPORT_NAME}.json`), JSON.stringify(report, null, 2));
  const markdown = [
    "# TypeSpec compatibility analysis",
    `Tool revision: \`${UPSTREAM_SHA}\``,
    ...PHASES.map((phase) => {
      const decision = evaluatePhase(report, phase, false, false);
      return `- ${OUTCOME_ICONS[decision.outcome]} ${LABELS[phase].check} (${PHASE_NAMES[phase].toLowerCase()}): **${decision.state}** - ${decision.description}`;
    }),
    ...report.failures.map(
      (failure) => `Analysis failure in \`${failure.path}\`: ${failure.message}`,
    ),
    ...report.projects.map(
      (project) => `## ${project.path}\n\n${formatProjectMarkdown(project.markdown, project.path)}`,
    ),
  ].join("\n\n");
  await writeFile(join(output, `${REPORT_NAME}.md`), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  return report;

  async function compile(project: string): Promise<Program> {
    const program = await tool.compileService(join(project, "main.tsp"));
    const errors = program.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      throw new Error(
        errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"),
      );
    }
    if (tool.enumerateVersions(program).length === 0) {
      throw new Error(
        "No versioned service found; upstream coverage is unavailable, not a clean result.",
      );
    }
    return program;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [upstream, base, output = ".typespec-breaking-change-demo"] = process.argv.slice(2);
  if (!upstream || !base)
    throw new Error("Usage: node analyze.ts <upstream-root> <base-ref> [output]");
  const root = git(process.cwd(), "rev-parse", "--show-toplevel");
  const report = await analyze(root, resolve(upstream), base, resolve(output));
  process.exitCode = report.failures.length > 0 ? 2 : 0;
}
