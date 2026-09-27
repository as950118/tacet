# @api-tacet/mcp

[Tacet](https://github.com/heonjinjeong/tacet) as MCP tools: check a TypeScript frontend against a Spring Boot API,
and see what an API, file or field change would affect.

**Standalone stdio server**

```json
{
  "mcpServers": {
    "tacet": {
      "command": "npx",
      "args": ["-y", "@api-tacet/mcp", "--index", "/abs/project/.tacet/index.db",
               "--frontend", "/abs/project/frontend", "--backend", "/abs/project/backend"]
    }
  }
}
```

**Add to an existing fastmcp server**

```ts
import { FastMCP } from "fastmcp";
import { addTacetTools } from "@api-tacet/mcp";

const server = new FastMCP({ name: "my-tools", version: "1.0.0" });
addTacetTools(server, { frontendDir: "./frontend", backendDir: "./backend", prefix: "tacet_" });
```

Other frameworks: `createTacetTools()` returns framework-neutral definitions (zod schema + JSON handler).
