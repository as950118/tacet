// Adding Tacet to an existing TypeScript fastmcp server.
import { FastMCP } from "fastmcp";
import { addTacetTools } from "@api-tacet/mcp";

const server = new FastMCP({ name: "my-dev-tools", version: "1.0.0" });

// ...the server's own tools...

addTacetTools(server, {
  indexPath: ".tacet/index.db",
  frontendDir: "./frontend",
  backendDir: "./backend",
  prefix: "tacet_",
});

await server.start({ transportType: "stdio" });
