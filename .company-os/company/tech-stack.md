# Tech Stack

## Product: ApiLens Platform (Tacet)

| Layer | Current | Notes |
|-------|---------|-------|
| Language | TypeScript (Node 22) | npm workspaces `packages/*` |
| Analysis core | `packages/core` | Extractors, `IndexStore`, snapshots |
| HTTP API | `packages/cli/src/server.ts` | Plain `node:http`, route table → OpenAPI |
| MCP | `packages/mcp`, `python/` (FastMCP) | Thin wrappers over the core library |
| Index store | SQLite (`node:sqlite`) / PostgreSQL (`pg`) | Selected by `TACET_INDEX`; treated as a cache (rebuilt on schema change) |
| Hosted DB | Supabase Postgres | `?schema=tacet` |
| Auth (planned) | Supabase Auth | See ADR-0002 |
| Dashboard | Next.js 16 App Router, React 19 | `web/`, Vercel (`sin1`) |
| API hosting | Render (Docker, `render.yaml`) | Read-only image by default |
| Tests | Vitest (`npm test`), pytest (`python/`) | Web: `npm run typecheck` only |

## Knowledge

| Asset | Location |
|-------|----------|
| Product architecture | `/ARCHITECTURE.md`, `/DEPLOY.md` |
| Company OS | `.company-os/company/`, `roles/`, `skills/`, `workflows/` |
| Specs | `.company-os/projects/apilens-platform/` |
| Decisions | `.company-os/projects/apilens-platform/adr/`, indexed in `memory/decision-memory/` |
| Tasks | `.company-os/tasks/` |

## Forbidden without ADR

- Adding an HTTP framework to `server.ts` (keep the route table)
- Mixing account/tenant tables into the cache-style index schema (they need real migrations)
- Secrets in git
- Skipping Reviewer/QA on production path
