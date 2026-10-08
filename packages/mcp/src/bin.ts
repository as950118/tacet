#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { relaunchWithLargerHeap } from "@tacet-api/cli";
import { createTacetMcpServer } from "./server.js";

if (relaunchWithLargerHeap()) process.exit(process.exitCode ?? 0);

const { values } = parseArgs({
  options: {
    index: { type: "string", short: "i" },
    config: { type: "string", short: "c" },
    frontend: { type: "string" },
    backend: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  // stderr: stdout is reserved for the MCP protocol.
  console.error(
    "Usage: tacet-mcp [--index .tacet/index.db] [--config tacet.config.json] [--frontend dir] [--backend dir]\n" +
      "Env fallbacks: TACET_INDEX, TACET_CONFIG, TACET_FRONTEND, TACET_BACKEND",
  );
  process.exit(0);
}

const server = createTacetMcpServer({
  indexPath: values.index ?? process.env.TACET_INDEX,
  configPath: values.config ?? process.env.TACET_CONFIG,
  frontendDir: values.frontend ?? process.env.TACET_FRONTEND,
  backendDir: values.backend ?? process.env.TACET_BACKEND,
});
await server.connect(new StdioServerTransport());
