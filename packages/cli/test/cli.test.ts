import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_JAR_PATH } from "@tacet-api/extractor-java";
import type { AiProvider, AiVerificationRequest } from "@tacet-api/core";
import { runCi } from "../src/ci.js";
import { TacetWorkspace } from "../src/workspace.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = join(repoRoot, "test/fixtures");
const bin = join(repoRoot, "packages/cli/dist/bin.js");
const hasJar = existsSync(DEFAULT_JAR_PATH);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tacet-cli-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function copyFrontend(name: string): string {
  const target = join(dir, name);
  cpSync(join(fixtures, "frontend"), target, { recursive: true });
  cpSync(join(fixtures, "tacet.config.json"), join(target, "tacet.config.json"));
  return target;
}

describe("TacetWorkspace.indexFrontend", () => {
  it("builds the index and reports every file on the first run", async () => {
    const ws = new TacetWorkspace(join(dir, "full.db"));
    const result = await ws.indexFrontend(join(fixtures, "frontend"), {
      configPath: join(fixtures, "tacet.config.json"),
    });
    expect(result.summary).toMatchObject({ files: 9, apiCalls: 15, resolvedApiCalls: 15 });
    expect(result.changedFiles).toHaveLength(9);
    expect(result.scope).toBeNull();
  });

  it("rewrites only the changed file and lists the APIs it uses", async () => {
    const frontend = copyFrontend("incremental");
    const ws = new TacetWorkspace(join(dir, "incremental.db"));
    await ws.indexFrontend(frontend);

    const card = join(frontend, "src/components/UserCard.tsx");
    writeFileSync(card, readFileSync(card, "utf8").replace("user.name", "user.username"));
    const result = await ws.indexFrontend(frontend, { files: [card] });
    expect(result.scope).toEqual(["src/components/UserCard.tsx"]);
    expect(result.changedFiles).toEqual(["src/components/UserCard.tsx"]);
    expect(result.apis.map((a) => a.apiKey)).toEqual(["GET /users/{param}"]);
  });

  it("rejects a missing frontend directory", async () => {
    await expect(new TacetWorkspace(join(dir, "x.db")).indexFrontend(join(dir, "missing"))).rejects.toThrow(
      "Frontend directory not found",
    );
  });

  it("explains how to recover when the index is empty", () => {
    expect(() => new TacetWorkspace(join(dir, "empty.db")).model()).toThrow("Run `tacet index");
  });
});

describe.skipIf(!hasJar)("with the backend contract", () => {
  let ws: TacetWorkspace;

  beforeAll(async () => {
    ws = new TacetWorkspace(join(dir, "contract.db"));
    await ws.indexFrontend(join(fixtures, "frontend"), { configPath: join(fixtures, "tacet.config.json") });
    await ws.extractBackend(join(fixtures, "backend"));
  });

  it("keeps the relations in the index and answers page / API / relation queries from it", () => {
    const byPage = ws.relations({ page: "UserPage" });
    expect(byPage.pageApis.map((u) => u.apiKey)).toContain("GET /users/{id}");
    const byApi = ws.relations({ api: "GET /users/{id}" });
    expect(byApi.pageApis.map((u) => byApi.entities[u.page].label)).toContain("UserPage (page)");
    const renders = ws.relations({ subject: "UserPage", predicate: "renders" });
    expect(renders.relations.map((t) => renders.entities[t.object].label)).toContain("UserCard");
    expect(() => ws.relations({ page: "/nope" })).toThrow('No Page "/nope"');
  });

  it("rebuilds the stored relations when the common-API rule in the config changes", () => {
    const config = join(dir, "common.config.json");
    const base = JSON.parse(readFileSync(join(fixtures, "tacet.config.json"), "utf8"));
    writeFileSync(config, JSON.stringify({ ...base, commonApis: { include: ["GET /users/{id}"] } }));
    const custom = new TacetWorkspace(ws.indexPath, config).relations({ api: "GET /users/{id}" });
    expect(custom.pageApis.every((u) => u.common)).toBe(true);
    expect(ws.relations({ api: "GET /users/{id}" }).pageApis.some((u) => u.common)).toBe(false);
  });

  it("finds every planted contract violation and nothing else", () => {
    const report = ws.check();
    expect(report.result).toBe("FAIL");
    expect(report.issues.map((i) => `${i.code} ${i.file}:${i.line}`)).toEqual([
      "ENDPOINT_NOT_FOUND src/pages/UserAdmin.tsx:5",
      "METHOD_MISMATCH src/pages/UserAdmin.tsx:10",
      "FIELD_NOT_FOUND src/pages/UserAdmin.tsx:19",
      "FIELD_NOT_FOUND src/pages/UserAdmin.tsx:24",
      "NOT_AN_OBJECT src/pages/UserAdmin.tsx:24",
      "UNKNOWN_BODY_FIELD src/pages/UserAdmin.tsx:14",
      "UNKNOWN_QUERY_PARAM src/pages/UserAdmin.tsx:18",
    ]);
  });

  it("passes for files that use the API correctly", () => {
    const report = ws.check({ files: ["src/pages/User.tsx", "src/components/UserCard.tsx"] });
    expect(report.result).toBe("PASS");
    expect(report.apis.map((a) => a.apiKey)).toEqual(["GET /users/{id}"]);
  });

  it("verifies undecided findings with an AI provider, using real source snippets", async () => {
    const requests: AiVerificationRequest[] = [];
    const provider: AiProvider = {
      name: "fake",
      model: "fake-model",
      async verify(request) {
        requests.push(request);
        return {
          model: "fake-model",
          verdicts: request.candidates.map((c) => ({
            id: c.id,
            result: "PASS" as const,
            confidence: 0.6,
            reason: "Rendered as text only.",
            evidence: [{ file: c.file, line: c.line, code: c.code }],
          })),
        };
      },
    };
    const report = await ws.verifyChanges(join(fixtures, "backend-v2"), { provider });

    expect(report.staticResult).toBe("FAIL");
    expect(report.result).toBe("FAIL"); // DEFINITE findings are never overridden
    expect(report.ai).toMatchObject({ provider: "fake", verified: 6, candidates: 6, discarded: 0 });
    const sent = requests.flatMap((r) => r.candidates);
    expect(sent.every((c) => c.staticConfidence !== ("DEFINITE" as string))).toBe(true);

    const userRequest = requests.find((r) => r.endpointId === "GET /users/{id}")!;
    const page = userRequest.snippets.find((s) => s.file === "src/pages/User.tsx")!;
    expect(page.lines[19 - page.startLine]).toContain("<span>{user.age}</span>");
    expect(userRequest.afterSchema).toContain("age: string | null;");
    expect(userRequest.beforeSchema).toContain("age: number;");

    const getUsers = report.endpoints.find((e) => e.endpointId === "GET /users")!;
    expect(getUsers.result).toBe("FAIL");
  });

  it("runs the CI flow without git: first run stores the baseline, next run compares against it", async () => {
    const ciWs = new TacetWorkspace(join(dir, "ci-baseline.db"), join(fixtures, "tacet.config.json"));
    const out = join(dir, "ci-baseline");
    const first = await runCi(ciWs, { frontendDir: join(fixtures, "frontend"), backendDir: join(fixtures, "backend"), outDir: out, checkFailOn: "never" });
    expect(first.changes).toBeNull();
    expect(first.changesSkipped).toContain("No git base ref");
    expect(first.exitCode).toBe(0);

    const second = await runCi(ciWs, { frontendDir: join(fixtures, "frontend"), backendDir: join(fixtures, "backend-v2"), outDir: out, checkFailOn: "never" });
    expect(second.changes?.result).toBe("FAIL");
    expect(second.exitCode).toBe(1);
    expect(readFileSync(second.files.report, "utf8")).toContain("Tacet: backend API change report: FAIL");
    expect(JSON.parse(readFileSync(second.files.json, "utf8")).exitCode).toBe(1);
  });

  it("answers impact questions from the index", () => {
    const analyzer = ws.impact();
    expect(analyzer.impactOfApi("GET /users/{id}")[0].files).toEqual([
      "src/api/user.ts",
      "src/components/UserCard.tsx",
      "src/pages/User.tsx",
      "src/pages/UserAdmin.tsx",
    ]);
    expect(analyzer.impactOfFile("src/api/user.ts").blastRadius.files).toHaveLength(5);
    expect(analyzer.summary().unusedEndpoints).toEqual([
      "DELETE /admin/users/{id}/sessions",
      "GET /users/summary",
      "PATCH /users/{id}/status",
    ]);
  });
});

describe.skipIf(!hasJar || !existsSync(bin))("tacet CLI", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [bin, "-i", join(dir, "cli.db"), ...args], { encoding: "utf8" });

  beforeAll(() => {
    expect(run("index", join(fixtures, "frontend"), "-c", join(fixtures, "tacet.config.json")).status).toBe(0);
    expect(run("extract-backend", join(fixtures, "backend")).status).toBe(0);
  });

  it("exits 1 when the contract check fails and 0 with --fail-on never", () => {
    const failing = run("check");
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("Tacet contract check: FAIL");
    expect(failing.stdout).toContain("Did you mean `name`?");
    expect(run("check", "--fail-on", "never").status).toBe(0);
  });

  it("prints JSON for machine consumers", () => {
    const report = JSON.parse(run("check", "--format", "json", "--files", "src/pages/Product.tsx").stdout);
    expect(report).toMatchObject({ result: "PASS", scope: ["src/pages/Product.tsx"] });
  });

  it("renders impact as text, Mermaid and HTML", () => {
    expect(run("impact", "--api", "GET /users/{id}").stdout).toContain("Affects 4 files");
    expect(run("impact", "--field", "UserResponse.name", "-f", "mermaid").stdout).toMatch(/^flowchart LR/);
    const html = join(dir, "graph.html");
    expect(run("graph", "-o", html).status).toBe(0);
    expect(readFileSync(html, "utf8")).toContain("<title>Tacet impact graph</title>");
  });

  it("renders the ontology: page → API text, JSON, Turtle and the HTML explorer", () => {
    const text = run("ontology", "-f", "text").stdout;
    expect(text).toContain("Pages → APIs (2):");
    expect(text).toMatch(/✓ GET \/users\/\{id\}\s+UserPage/);
    const ontology = JSON.parse(run("ontology", "-f", "json", "--focus", "UserCard").stdout);
    expect(ontology.entities.map((e: { label: string }) => e.label)).toEqual(expect.arrayContaining(["UserCard", "UserResponse.name"]));
    expect(run("ontology", "-f", "turtle").stdout).toContain("tacet:usesApi a owl:ObjectProperty");
    const html = join(dir, "ontology.html");
    expect(run("ontology", "-o", html).status).toBe(0);
    expect(readFileSync(html, "utf8")).toContain("<title>Tacet ontology</title>");
  });

  it("reports frontend impact of backend changes and fails on definite impact", () => {
    const text = run("analyze", "--backend", join(fixtures, "backend-v2"));
    expect(text.status).toBe(1);
    expect(text.stdout).toContain("Tacet API change report: FAIL");
    expect(text.stdout).toContain("PUT /users/{id}  [moved → PUT /users/{id}/profile]");
    const report = JSON.parse(run("analyze", "--backend", join(fixtures, "backend-v2"), "-f", "json", "--fail-on", "never").stdout);
    expect(report.counts).toMatchObject({ changedApis: 8, DEFINITE: 9, LIKELY: 2, POSSIBLE: 4 });
    // The baseline is unchanged unless --save is given.
    expect(run("analyze", "--backend", join(fixtures, "backend"), "-f", "json").status).toBe(0);
  });

  it("diffs the backend between git refs", () => {
    const repo = join(dir, "diff-repo");
    cpSync(join(fixtures, "frontend"), join(repo, "frontend"), { recursive: true });
    cpSync(join(fixtures, "tacet.config.json"), join(repo, "frontend/tacet.config.json"));
    cpSync(join(fixtures, "backend"), join(repo, "backend"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    const commit = (message: string) => {
      git("add", "-A");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", message);
    };
    git("init", "-q");
    commit("v1");
    rmSync(join(repo, "backend"), { recursive: true });
    cpSync(join(fixtures, "backend-v2"), join(repo, "backend"), { recursive: true });
    commit("v2");

    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [bin, "-i", join(dir, "diff.db"), ...args], { encoding: "utf8" });
    expect(cli("index", join(repo, "frontend")).status).toBe(0);

    const md = cli("diff", "--base", "HEAD~1", "--head", "HEAD", "--backend", join(repo, "backend"), "-f", "markdown");
    expect(md.status).toBe(1);
    expect(md.stdout).toContain("## Tacet: backend API changes HEAD~1...HEAD: FAIL");
    expect(md.stdout).toContain("| DEFINITE | `src/components/UserCard.tsx:4` UserCard | `user.name` |");

    const unchanged = cli("diff", "--base", "HEAD", "--backend", join(repo, "backend"));
    expect(unchanged.status).toBe(0);
    expect(unchanged.stdout).toContain("No backend changes");
  });

  it("runs the CI script: backend impact + changed-frontend contract check", () => {
    const repo = join(dir, "ci-repo");
    cpSync(join(fixtures, "frontend"), join(repo, "frontend"), { recursive: true });
    cpSync(join(fixtures, "tacet.config.json"), join(repo, "frontend/tacet.config.json"));
    cpSync(join(fixtures, "backend"), join(repo, "backend"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "base");

    const script = join(repoRoot, "scripts/tacet-ci.sh");
    const env = { ...process.env, TACET_FRONTEND: "frontend", TACET_BACKEND: "backend", TACET_BASE: "HEAD", TACET_OUT: join(repo, ".out") };
    const clean = spawnSync("bash", [script], { cwd: repo, env, encoding: "utf8" });
    expect(clean.status).toBe(0);
    expect(readFileSync(join(repo, ".out/report.md"), "utf8")).toContain("frontend contract check: PASS");

    const product = join(repo, "frontend/src/pages/Product.tsx");
    writeFileSync(product, readFileSync(product, "utf8").replace("product.price", "product.cost"));
    rmSync(join(repo, "backend"), { recursive: true });
    cpSync(join(fixtures, "backend-v2"), join(repo, "backend"), { recursive: true });
    const failing = spawnSync("bash", [script], { cwd: repo, env, encoding: "utf8" });
    expect(failing.status).toBe(1);
    const report = readFileSync(join(repo, ".out/report.md"), "utf8");
    expect(report).toContain("backend API changes HEAD...working tree: FAIL");
    expect(report).toContain("ProductResponse has no field `cost`");
  });

  it("checks only the files changed since a git ref", () => {
    const frontend = copyFrontend("git");
    const git = (...args: string[]) => execFileSync("git", ["-C", frontend, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "base");
    const product = join(frontend, "src/pages/Product.tsx");
    writeFileSync(product, readFileSync(product, "utf8").replace("product.price", "product.cost"));

    const index = spawnSync(process.execPath, [bin, "-i", join(dir, "git.db"), "index", frontend], { encoding: "utf8" });
    expect(index.status).toBe(0);
    spawnSync(process.execPath, [bin, "-i", join(dir, "git.db"), "extract-backend", join(fixtures, "backend")]);
    const check = spawnSync(
      process.execPath,
      [bin, "-i", join(dir, "git.db"), "index", frontend, "--changed-since", "HEAD", "--check"],
      { encoding: "utf8" },
    );
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("src/pages/Product.tsx");
    expect(check.stdout).toContain("ProductResponse has no field `cost`");
    expect(check.stdout).toContain("scope: 1 file");
  });
});
