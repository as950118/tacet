# @tacet-api/cli

Find the frontend code a backend API change breaks - before you deploy - and check frontend code against the real API.
Tacet reads a **TypeScript** frontend and a **Spring Boot** backend from source (no build), links every API call to its
endpoint, and traces response fields down to the components that read them.

Requires Node.js 22.13+ and Java 17+ (for the backend extractor).

```bash
npm install -g @tacet-api/cli

tacet index ./frontend                          # analyze the frontend
tacet extract-backend ./backend                 # extract the API contract
tacet check                                     # frontend usage vs the real contract
tacet diff --base origin/main --backend ./backend   # what a backend change breaks
tacet impact --api "GET /users/{id}"            # what depends on this API (also --file, --field)
tacet graph -o graph.html                       # interactive API -> component -> file graph
tacet ontology -f text                          # which page uses which API (html / json / turtle / mermaid)
tacet ci --frontend ./frontend --backend ./backend --base origin/main   # everything, for CI
tacet verify --backend ./backend --base origin/main   # + AI review of undecided findings (ANTHROPIC_API_KEY)
```

Every command supports `--format json`; reports also render as Markdown for PR comments.
Documentation: https://github.com/heonjinjeong/tacet
