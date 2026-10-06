import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FastMCP } from "fastmcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_JAR_PATH } from "@tacet-api/extractor-java";
import { addTacetTools, createTacetTools } from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = join(repoRoot, "test/fixtures");
const frontendDir = join(fixtures, "frontend");
const backendDir = join(fixtures, "backend");
const bin = join(repoRoot, "packages/mcp/dist/bin.js");
const hasJar = existsSync(DEFAULT_JAR_PATH);

const TOOL_NAMES = [
  "analyze_api_changes",
  "check_contract",
  "diff_api_changes",
  "extract_backend",
  "impact_of_api",
  "impact_of_field",
  "impact_of_file",
  "impact_summary",
  "index_frontend",
  "ontology",
  "page_apis",
  "render_graph",
  "search",
  "verify_api_changes",
];

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tacet-mcp-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function text(result: unknown): string {
  return (result as { content: { type: string; text: string }[] }).content[0].text;
}

describe("createTacetTools", () => {
  it("defines every tool with a zod schema", () => {
    const tools = createTacetTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    const readOnly = tools.filter((t) => t.readOnly).map((t) => t.name).sort();
    expect(readOnly).toEqual(["check_contract", "diff_api_changes", "impact_of_api", "impact_of_field", "impact_of_file", "impact_summary", "page_apis", "search", "verify_api_changes"]);
    expect(tools.find((t) => t.name === "impact_of_api")!.parameters.parse({ api: "GET /x" })).toEqual({
      api: "GET /x",
      graph: "none",
    });
  });

  it("explains a missing default directory", async () => {
    const index = createTacetTools({ indexPath: join(dir, "none.db") }).find((t) => t.name === "index_frontend")!;
    await expect(index.run({})).rejects.toThrow("`frontendDir` is required");
  });

  it.skipIf(!hasJar)("runs the index → check → impact flow", async () => {
    const tools = Object.fromEntries(
      createTacetTools({
        indexPath: join(dir, "tools.db"),
        configPath: join(fixtures, "tacet.config.json"),
        frontendDir,
        backendDir,
      }).map((t) => [t.name, t]),
    );
    await tools.index_frontend.run({});
    await tools.extract_backend.run({});
    const report = (await tools.check_contract.run({ files: ["src/pages/Product.tsx"] })) as { result: string };
    expect(report.result).toBe("PASS");

    const [impact] = (await tools.impact_of_api.run({ api: "GET /users/{id}", graph: "mermaid" })) as Array<
      Record<string, unknown>
    >;
    expect(impact.files).toHaveLength(4);
    expect(impact).not.toHaveProperty("graph");
    expect(String(impact.mermaid)).toMatch(/^flowchart LR/);

    const changes = (await tools.analyze_api_changes.run({
      backendDir: join(fixtures, "backend-v2"),
      format: "markdown",
    })) as { result: string; markdown: string };
    expect(changes.result).toBe("FAIL");
    expect(changes.markdown).toContain("moved → `PUT /users/{id}/profile`");

    const verified = (await createTacetTools({
      indexPath: join(dir, "tools.db"),
      backendDir: join(fixtures, "backend-v2"),
      aiProvider: {
        name: "fake",
        model: "fake-model",
        verify: async (request) => ({ model: "fake-model", verdicts: request.candidates.map((c) => ({ id: c.id, result: "UNKNOWN", confidence: 0, reason: "n/a", evidence: [] })) }),
      },
    }).find((t) => t.name === "verify_api_changes")!.run({})) as { ai: { verified: number; counts: { UNKNOWN: number } } };
    expect(verified.ai.verified).toBe(6);
    expect(verified.ai.counts.UNKNOWN).toBe(6);

    const html = (await tools.render_graph.run({ format: "html", outPath: join(dir, "g.html") })) as { path: string };
    expect(existsSync(html.path)).toBe(true);

    const pages = (await tools.page_apis.run({ api: "GET /users/{id}" })) as Array<{ apiKey: string; pages: { component: string }[] }>;
    expect(pages.find((p) => p.apiKey === "GET /users/{id}")?.pages.map((p) => p.component)).toEqual(["UserPage"]);
    const ontology = (await tools.ontology.run({ focus: "UserPage", format: "mermaid" })) as { mermaid: string };
    expect(ontology.mermaid).toContain("|showsComponent|");
    expect(await tools.ontology.run({ focus: "nothing-like-this" })).toMatchObject({ error: expect.stringContaining("No entity") });
  });
});

describe.skipIf(!hasJar || !existsSync(bin))("tacet-mcp stdio server", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bin, "--index", join(dir, "stdio.db"), "--frontend", frontendDir, "--backend", backendDir,
          "--config", join(fixtures, "tacet.config.json")],
        stderr: "pipe",
      }),
    );
  });

  afterAll(async () => {
    await client?.close();
  });

  it("lists the Tacet tools with annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    expect(tools.find((t) => t.name === "check_contract")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "impact_of_api")?.inputSchema.required).toEqual(["api"]);
  });

  it("indexes, checks the contract and answers impact questions", async () => {
    const indexed = JSON.parse(text(await client.callTool({ name: "index_frontend", arguments: {} })));
    expect(indexed.summary.apiCalls).toBe(15);
    await client.callTool({ name: "extract_backend", arguments: {} });

    const report = JSON.parse(text(await client.callTool({ name: "check_contract", arguments: {} })));
    expect(report.result).toBe("FAIL");
    expect(report.counts).toEqual({ error: 5, warning: 2, info: 0 });

    const field = JSON.parse(text(await client.callTool({ name: "impact_of_field", arguments: { field: "UserResponse.name" } })));
    expect(field[0].files).toEqual(["src/components/UserCard.tsx", "src/pages/User.tsx", "src/pages/UserList.tsx"]);
  });

  it("returns tool errors instead of crashing", async () => {
    const result = await client.callTool({ name: "impact_of_file", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

describe.skipIf(!hasJar)("addTacetTools on a real fastmcp server", () => {
  let server: FastMCP;
  let client: Client;

  beforeAll(async () => {
    server = new FastMCP({ name: "host", version: "1.0.0" });
    server.addTool({ name: "host_tool", description: "The host's own tool", execute: async () => "ok" });
    const names = addTacetTools(server, {
      indexPath: join(dir, "fastmcp.db"),
      configPath: join(fixtures, "tacet.config.json"),
      frontendDir,
      backendDir,
      prefix: "tacet_",
    });
    expect(names).toHaveLength(TOOL_NAMES.length);

    const port = await freePort();
    await server.start({ transportType: "httpStream", httpStream: { port, host: "127.0.0.1" } });
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  it("registers prefixed tools next to the host's tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["host_tool", ...TOOL_NAMES.map((n) => `tacet_${n}`)].sort());
  });

  it("executes Tacet tools through fastmcp", async () => {
    await client.callTool({ name: "tacet_index_frontend", arguments: {} });
    await client.callTool({ name: "tacet_extract_backend", arguments: {} });
    const hits = JSON.parse(text(await client.callTool({ name: "tacet_search", arguments: { query: "UserCard" } })));
    expect(hits).toContainEqual(expect.objectContaining({ kind: "component", label: "UserCard", apis: 1 }));
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}
