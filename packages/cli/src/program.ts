import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command, Option } from "commander";
import {
  attachGraph,
  mergeGraphs,
  renderHtml,
  renderMermaid,
  renderChangeReportMarkdown,
  renderContractReportMarkdown,
  type ChangeReport,
  type ContractReport,
  type VerifiedChangeReport,
  type GraphAttachment,
  type ImpactGraph,
} from "@tacet-api/core";
import {
  formatApiImpact,
  formatChangeReport,
  formatBackendResult,
  formatContractReport,
  formatFieldImpact,
  formatFileImpact,
  formatIndexResult,
  formatSearch,
  formatSummary,
} from "./format.js";
import type { Effort } from "@tacet-api/ai-anthropic";
import { AI_PROVIDERS, createAiProvider } from "./ai.js";
import { runCi, type CheckFailOn, type VerifyFailOn } from "./ci.js";
import { TacetWorkspace, DEFAULT_INDEX_PATH } from "./workspace.js";

const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

type Format = "text" | "json" | "mermaid" | "html" | "markdown";
type ImpactFailOn = "definite" | "likely" | "possible" | "never";
type FailOn = "error" | "warning" | "never";

const formatOption = (choices: Format[], fallback: Format) =>
  new Option("-f, --format <format>", "output format").choices(choices).default(fallback);
const failOnOption = () =>
  new Option("--fail-on <level>", "exit with code 1 when issues at this level exist")
    .choices(["error", "warning", "never"])
    .default("error");

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("tacet")
    .description("Find the frontend code affected by backend API changes, and check frontend code against the real API")
    .version(VERSION)
    .option("-i, --index <path>", "index database", DEFAULT_INDEX_PATH)
    .option("-c, --config <path>", "tacet.config.json (defaults to <frontendDir>/tacet.config.json at index time)");

  const workspace = () => {
    const opts = program.opts<{ index: string; config?: string }>();
    return new TacetWorkspace(opts.index, opts.config);
  };

  program
    .command("index")
    .description("Analyze a TypeScript frontend and update the index (only changed records are rewritten)")
    .argument("<frontendDir>", "frontend project root")
    .option("--files <files...>", "files that changed: report the APIs they use")
    .option("--changed-since <ref>", "use the TS files changed since this git ref as --files")
    .option("--check", "also check the changed files against the backend contract")
    .addOption(failOnOption())
    .addOption(formatOption(["text", "json"], "text"))
    .option("-m, --manifest <path>", "also write the extracted manifest as JSON")
    .action(async (frontendDir: string, opts: { files?: string[]; changedSince?: string; check?: boolean; failOn: FailOn; format: Format; manifest?: string }) => {
      const ws = workspace();
      const result = await ws.indexFrontend(frontendDir, {
        files: opts.files,
        changedSince: opts.changedSince,
        manifestPath: opts.manifest,
      });
      const report = opts.check ? ws.check({ files: result.scope ?? undefined }) : null;
      if (opts.format === "json") {
        console.log(JSON.stringify(report ? { ...result, check: report } : result, null, 2));
      } else {
        console.log(formatIndexResult(result));
        if (report) console.log(`\n${formatContractReport(report)}`);
      }
      if (report) setExitCode(report, opts.failOn);
    });

  program
    .command("extract-backend")
    .description("Extract the API contract (endpoints, DTOs) from a Spring Boot backend into the index")
    .argument("<backendDir>", "backend project root")
    .option("-o, --out <path>", "also write the backend manifest as JSON")
    .option("--jar <path>", "Java extractor JAR (defaults to the bundled one)")
    .addOption(formatOption(["text", "json"], "text"))
    .action(async (backendDir: string, opts: { out?: string; jar?: string; format: Format }) => {
      const result = await workspace().extractBackend(backendDir, { outPath: opts.out, jarPath: opts.jar });
      console.log(opts.format === "json" ? JSON.stringify(result, null, 2) : formatBackendResult(result, opts.out));
    });

  program
    .command("check")
    .description("Check frontend API usage against the backend contract (endpoints, methods, fields, params)")
    .option("--files <files...>", "only APIs used by these files")
    .option("--changed-since <ref>", "only APIs used by TS files changed since this git ref")
    .addOption(formatOption(["text", "json", "markdown"], "text"))
    .addOption(failOnOption())
    .option("-o, --out <path>", "write the report to a file")
    .action((opts: { files?: string[]; changedSince?: string; format: Format; failOn: FailOn; out?: string }) => {
      const report = workspace().check({ files: opts.files, changedSince: opts.changedSince });
      const output =
        opts.format === "json"
          ? JSON.stringify(report, null, 2)
          : opts.format === "markdown"
            ? renderContractReportMarkdown(report)
            : formatContractReport(report);
      emit(output, opts.out);
      setExitCode(report, opts.failOn);
    });

  program
    .command("impact")
    .description("Show what a change would affect, without changing anything")
    .option("--api <api>", 'an API, e.g. "GET /users/{id}" or "/users/{id}"')
    .option("--file <file>", "a frontend file")
    .option("--field <field>", 'a response field, e.g. "UserResponse.name"')
    .option("--search <text>", "search APIs, files, functions, components, DTOs and fields")
    .option("--summary", "rank every API and file by impact")
    .addOption(formatOption(["text", "json", "mermaid", "html"], "text"))
    .addOption(
      new Option("--graph <mode>", "with --format json: include the graph as json, as mermaid text, or not at all")
        .choices(["none", "mermaid", "json"])
        .default("json"),
    )
    .option("-o, --out <path>", "write the output to a file")
    .action((opts: { api?: string; file?: string; field?: string; search?: string; summary?: boolean; format: Format; graph: GraphAttachment; out?: string }) => {
      const ws = workspace();
      const analyzer = ws.impact();
      let value: unknown;
      let text: string;
      let graph: ImpactGraph | null = null;
      let title: string;
      if (opts.api) {
        const impacts = analyzer.impactOfApi(opts.api);
        value = impacts.map((i) => attachGraph(i, opts.graph));
        text = formatApiImpact(impacts, opts.api);
        graph = mergeGraphs(impacts.map((i) => i.graph));
        title = `Impact of ${opts.api}`;
      } else if (opts.file) {
        const impact = analyzer.impactOfFile(ws.toIndexPath(opts.file));
        value = attachGraph(impact, opts.graph);
        text = formatFileImpact(impact);
        graph = impact.graph;
        title = `Impact of changing ${impact.file}`;
      } else if (opts.field) {
        const impacts = analyzer.impactOfField(opts.field);
        value = impacts.map((i) => attachGraph(i, opts.graph));
        text = formatFieldImpact(impacts, opts.field);
        graph = mergeGraphs(impacts.map((i) => i.graph));
        title = `Impact of ${opts.field}`;
      } else if (opts.search) {
        const hits = analyzer.search(opts.search);
        value = hits;
        text = formatSearch(hits, opts.search);
        title = `Search: ${opts.search}`;
      } else if (opts.summary) {
        const summary = analyzer.summary();
        value = summary;
        text = formatSummary(summary);
        graph = analyzer.fullGraph();
        title = "Tacet impact overview";
      } else {
        throw new Error("Specify one of --api, --file, --field, --search or --summary");
      }
      emit(render(opts.format, { value, text, graph, title }), opts.out);
    });

  program
    .command("graph")
    .description("Render the full API → field → function → component → file graph")
    .addOption(formatOption(["html", "mermaid", "json"], "html"))
    .option("-o, --out <path>", "output file (default .tacet/graph.html for html)")
    .action((opts: { format: Format; out?: string }) => {
      const analyzer = workspace().impact();
      const graph = analyzer.fullGraph();
      const out = opts.out ?? (opts.format === "html" ? ".tacet/graph.html" : undefined);
      emit(render(opts.format, { value: graph, text: "", graph, title: "Tacet impact graph" }), out);
    });

  const impactFailOn = () =>
    new Option("--fail-on <level>", "exit with code 1 when frontend impact at this confidence (or higher) exists")
      .choices(["definite", "likely", "possible", "never"])
      .default("definite");

  program
    .command("analyze")
    .description("Diff the backend contract in the index against a backend directory and find affected frontend code")
    .requiredOption("--backend <dir>", "backend project root with the changed API")
    .option("--save", "store the analyzed backend as the new baseline")
    .option("--jar <path>", "Java extractor JAR (defaults to the bundled one)")
    .addOption(formatOption(["text", "json", "markdown"], "text"))
    .addOption(impactFailOn())
    .option("-o, --out <path>", "write the report to a file")
    .action(async (opts: { backend: string; save?: boolean; jar?: string; format: Format; failOn: ImpactFailOn; out?: string }) => {
      const report = await workspace().analyzeBackend(opts.backend, { save: opts.save, jarPath: opts.jar });
      emit(renderChanges(report, opts.format), opts.out);
      setImpactExitCode(report, opts.failOn);
    });

  program
    .command("diff")
    .description("Compare the backend API between two git refs and find affected frontend code")
    .requiredOption("--base <ref>", "git ref the frontend was written against, e.g. origin/main")
    .option("--head <ref>", "git ref with the backend change (default: the working tree)")
    .requiredOption("--backend <dir>", "backend project root (inside the git repository)")
    .option("--jar <path>", "Java extractor JAR (defaults to the bundled one)")
    .addOption(formatOption(["text", "json", "markdown"], "text"))
    .addOption(impactFailOn())
    .option("-o, --out <path>", "write the report to a file")
    .action(async (opts: { base: string; head?: string; backend: string; jar?: string; format: Format; failOn: ImpactFailOn; out?: string }) => {
      const report = await workspace().diffBackend(opts.backend, { base: opts.base, head: opts.head, jarPath: opts.jar });
      if (!report.backendChanged && opts.format === "text") {
        emit(`No backend changes under ${opts.backend} between ${report.base} and ${report.head}.`, opts.out);
        return;
      }
      emit(
        renderChanges(report, opts.format, `Tacet: backend API changes ${report.base}...${report.head}`),
        opts.out,
      );
      setImpactExitCode(report, opts.failOn);
    });

  program
    .command("ci")
    .description("Full pull-request check: index frontend, backend API change impact, contract check of changed files")
    .requiredOption("--frontend <dir>", "frontend project root")
    .requiredOption("--backend <dir>", "backend project root")
    .option("--base <ref>", "git ref to compare against (without it, the stored backend contract is the baseline)")
    .option("--out <dir>", "report directory", ".tacet")
    .option("--ai-provider <name>", "verify undecided findings with AI (e.g. anthropic)", process.env.TACET_AI_PROVIDER)
    .option("--ai-model <model>", "model id for AI verification", process.env.TACET_AI_MODEL)
    .addOption(impactFailOn())
    .addOption(new Option("--check-fail-on <level>", "contract check failure level").choices(["error", "warning", "never"]).default("error"))
    .addOption(new Option("--verify-fail-on <level>", "with --ai-provider: verified result failure level").choices(["fail", "warning", "never"]).default("fail"))
    .option("--jar <path>", "Java extractor JAR (defaults to the bundled one)")
    .action(async (opts: {
      frontend: string; backend: string; base?: string; out: string; aiProvider?: string; aiModel?: string;
      failOn: ImpactFailOn; checkFailOn: CheckFailOn; verifyFailOn: VerifyFailOn; jar?: string;
    }) => {
      const aiProvider = opts.aiProvider && opts.aiProvider !== "none"
        ? createAiProvider(opts.aiProvider, { model: opts.aiModel })
        : undefined;
      const result = await runCi(workspace(), {
        frontendDir: opts.frontend,
        backendDir: opts.backend,
        base: opts.base,
        outDir: opts.out,
        aiProvider,
        failOn: opts.failOn,
        checkFailOn: opts.checkFailOn,
        verifyFailOn: opts.verifyFailOn,
        jarPath: opts.jar,
      });
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(result.files.report, "utf8"));
      const changes = result.changes ? `backend changes ${result.changes.result}` : "backend changes skipped";
      console.log(`Tacet: ${changes}, contract check ${result.contract.result} -> ${result.files.report}`);
      process.exitCode = result.exitCode;
    });

  program
    .command("verify")
    .description("Change analysis + AI verification of the findings static analysis could not decide")
    .requiredOption("--backend <dir>", "backend project root with the changed API")
    .option("--base <ref>", "compare git refs (like `diff`) instead of the contract stored in the index")
    .option("--head <ref>", "with --base: git ref with the change (default: the working tree)")
    .addOption(new Option("--provider <name>", "AI provider").choices([...AI_PROVIDERS]).default(process.env.TACET_AI_PROVIDER ?? "anthropic"))
    .option("--model <model>", "model id (default: $TACET_AI_MODEL or the provider default)")
    .addOption(new Option("--effort <level>", "reasoning effort").choices(["low", "medium", "high", "xhigh", "max"]))
    .option("--max-candidates <n>", "at most this many locations per endpoint are sent to the model", (v) => Number.parseInt(v, 10), 25)
    .option("--jar <path>", "Java extractor JAR (defaults to the bundled one)")
    .addOption(formatOption(["text", "json", "markdown"], "text"))
    .addOption(
      new Option("--fail-on <level>", "exit with code 1 when the verified result is at this level or worse")
        .choices(["fail", "warning", "never"])
        .default("fail"),
    )
    .option("-o, --out <path>", "write the report to a file")
    .action(async (opts: {
      backend: string; base?: string; head?: string; provider: string; model?: string; effort?: Effort;
      maxCandidates: number; jar?: string; format: Format; failOn: "fail" | "warning" | "never"; out?: string;
    }) => {
      const provider = createAiProvider(opts.provider, { model: opts.model, effort: opts.effort });
      const report = await workspace().verifyChanges(opts.backend, {
        provider,
        base: opts.base,
        head: opts.head,
        jarPath: opts.jar,
        maxCandidatesPerEndpoint: opts.maxCandidates,
      });
      const title = report.base ? `Tacet: verified API changes ${report.base}...${report.head}` : "Tacet: verified API change report";
      emit(renderChanges(report, opts.format, title), opts.out);
      if ((opts.failOn === "fail" && report.result === "FAIL") || (opts.failOn === "warning" && report.result !== "PASS")) {
        process.exitCode = 1;
      }
    });

  return program;
}

function renderChanges(report: ChangeReport | VerifiedChangeReport, format: Format, title?: string): string {
  if (format === "json") return JSON.stringify(report, null, 2);
  if (format === "markdown") return renderChangeReportMarkdown(report, title);
  return formatChangeReport(report);
}

function setImpactExitCode(report: ChangeReport, failOn: ImpactFailOn): void {
  const c = report.counts;
  const failing =
    (failOn === "definite" && c.DEFINITE > 0) ||
    (failOn === "likely" && c.DEFINITE + c.LIKELY > 0) ||
    (failOn === "possible" && c.DEFINITE + c.LIKELY + c.POSSIBLE > 0);
  if (failing) process.exitCode = 1;
}

function render(
  format: Format,
  r: { value: unknown; text: string; graph: ImpactGraph | null; title: string },
): string {
  if (format === "json") return JSON.stringify(r.value, null, 2);
  if (format === "text") return r.text;
  if (!r.graph) throw new Error(`--format ${format} needs a graph; use it with --api, --file, --field or --summary`);
  return format === "mermaid" ? renderMermaid(r.graph) : renderHtml(r.graph, { title: r.title });
}

function emit(output: string, out?: string): void {
  if (!out) {
    console.log(output);
    return;
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, output);
  console.log(`Wrote ${resolve(out)}`);
}

function setExitCode(report: ContractReport, failOn: FailOn): void {
  const failing =
    (failOn === "error" && report.counts.error > 0) ||
    (failOn === "warning" && report.counts.error + report.counts.warning > 0);
  if (failing) process.exitCode = 1;
}
