# tacet (Python)

Python bindings for [Tacet](../README.md): check a TypeScript frontend against a Spring Boot API and see what
an API, file or field change would affect, plus ready-made tools for [FastMCP](https://gofastmcp.com).

The package drives the Tacet CLI (`--format json`), so the machine running it needs Node.js 22.13+
(and Java 17+ for `extract_backend`). Point it at the CLI with `TACET_CLI` or put `tacet` on `PATH`.

```python
from tacet import Tacet

lens = Tacet(index=".tacet/index.db", frontend_dir="./frontend", backend_dir="./backend")
lens.index_frontend()
lens.extract_backend()

report = lens.check(changed_since="origin/main")      # PASS / WARNING / FAIL + issues with file:line
lens.impact_of_api("GET /users/{id}", graph="mermaid")
lens.page_apis(api="GET /users/{id}")      # which pages use this API, and through what
lens.impact_of_file("src/api/user.ts")
lens.impact_of_field("UserResponse.name")
```

## FastMCP

```python
from fastmcp import FastMCP
from tacet.fastmcp import register_tools

mcp = FastMCP("my-server")
register_tools(mcp, frontend_dir="./frontend", backend_dir="./backend", prefix="tacet_")
mcp.run()
```

Tools: `index_frontend`, `extract_backend`, `check_contract`, `impact_of_api`, `impact_of_file`,
`impact_of_field`, `search`, `impact_summary`, `render_graph`, `page_apis`, `ontology`.

## Tests

```bash
npm run build && npm run build:jar   # from the repository root
uv run --group dev pytest
```
