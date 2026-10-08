# Tacet

Backend API가 바뀌었을 때, 기존 Frontend 코드 중 **무엇을 고쳐야 하는지** 배포 전에 알려주는 CLI 도구.

Frontend를 미리 인덱싱해두고, API가 바뀌면 그 API와 연결된 코드만 찾아 정적 분석한다.
AI는 정적으로 확정할 수 없는 부분을 검증하는 데만 쓴다. 설계는 [ARCHITECTURE.md](./ARCHITECTURE.md) 참고.

## 설치

| 사용처 | 설치 |
|---|---|
| CLI (npm) | `npm install -g @tacet-api/cli` → `tacet ...` |
| MCP 서버 | `npx -y @tacet-api/mcp --frontend ... --backend ...` |
| Node/TS 라이브러리 | `npm install @tacet-api/cli` (`TacetWorkspace`, `runCi`) / `@tacet-api/mcp` |
| Python / FastMCP | `pip install "tacet[fastmcp]"` (import 이름 `tacet`) |
| Gradle | `plugins { id("io.github.heonjinjeong.tacet") version "0.1.0" }` |
| Maven | `io.github.heonjinjeong:tacet-maven-plugin:0.1.0` |

모든 형태가 같은 CLI(`@tacet-api/cli`)를 실행한다. Python과 Gradle/Maven 플러그인은 `tacet`가 PATH에 없으면
같은 버전을 `npx`로 자동 실행하므로, 실행 환경에 Node.js 22.13+(와 backend 분석용 Java 17+)만 있으면 된다.

### Gradle

```kotlin
plugins { id("io.github.heonjinjeong.tacet") version "0.1.0" }

tacet {
    frontendDir = file("../frontend")
    // backendDir = 현재 프로젝트 (기본)
    // failOn = "definite" | "likely" | "possible" | "never"
    // checkFailOn = "error" | "warning" | "never"
    // aiProvider = "anthropic"          // ANTHROPIC_API_KEY
}
tasks.check { dependsOn("tacetCheck") }
```

`./gradlew tacetCheck -Ptacet.base=origin/main` — git 기준 비교. base가 없으면 `build/tacet/index.db`에 저장된
이전 계약과 비교한다(첫 실행이 기준이 된다). 리포트: `build/tacet/report.md`.

### Maven

```xml
<plugin>
  <groupId>io.github.heonjinjeong</groupId>
  <artifactId>tacet-maven-plugin</artifactId>
  <version>0.1.0</version>
  <executions><execution><goals><goal>check</goal></goals></execution></executions>
  <configuration>
    <frontendDir>${project.basedir}/../frontend</frontendDir>
    <!-- <base>origin/main</base> <failOn>definite</failOn> <checkFailOn>error</checkFailOn> -->
  </configuration>
</plugin>
```

`mvn verify -Dtacet.base=origin/main` (`verify` 단계에 연결됨). 리포트: `target/tacet/report.md`.

## 요구사항

- Node.js 22.13+ (내장 `node:sqlite` 사용)
- Java backend 분석 시 JDK 17+

## 설치 & 빌드

```bash
npm install
npm run build:jar   # Java extractor JAR (Gradle)
npm run build
npm test            # TS 테스트 (JAR가 있으면 Java 연동 테스트 포함)
npm run test:jvm    # Java extractor 단위 테스트
(cd python && uv run --group dev pytest)   # Python 바인딩 + FastMCP
```

## 사용법

모든 명령은 같은 index DB(`-i, --index`, 기본 `.tacet/index.db`)를 공유한다.

### 1. Frontend 인덱싱

```bash
node packages/cli/dist/bin.js index ./frontend
```

```text
Tacet index written to /path/.tacet/index.db
  Files:              9
  Functions:          22
  API calls:          15 (15 with resolved endpoint)
  Property accesses:  16
  Updated files:      9
```

인식하는 패턴 예:

```ts
axios.get(`/users/${id}`)                  // GET /users/{param}
api.put("/users/" + id, body)              // axios.create() 인스턴스
fetch(`/users/${id}`, { method: "DELETE" })

const user = await getUser(id)             // wrapper 함수 자동 추론
const { name } = await getUser(id)         // → name
console.log(user?.profile.email)           // → profile.email
return <h1>{user.name}</h1>                // → name
<UserCard user={user} />                   // 자식 컴포넌트까지 추적
users.map((u) => u.name)                   // → [].name
transform(user).name                       // → name (derived: 확실하지 않음)
axios.get("/users", { params: { page } })  // query key: page
```

Vue 단일 파일 컴포넌트(`.vue`)도 분석한다. `<script>`/`<script setup>`은 그대로, `<template>`의 표현식(`{{ }}`, `:prop`,
`v-if`, `v-for`, `@event`, `v-slot`)은 같은 줄의 TypeScript로 바꿔 분석한다. Vue Query 결과(`data.value`), `ref`/`computed`,
template의 ref 자동 unwrap, `<UserCard :user="u" />` → 자식의 `defineProps`까지 추적한다.

```vue
<li v-for="u in users.data" :key="u.id">{{ u.name }}</li>   <!-- → data[].id, data[].name -->
<UserCard :user-info="u" />                                <!-- UserCard.vue의 userInfo.email까지 -->
```

큰 프로젝트에서는 TypeScript type checker가 Node 기본 heap(약 4GB)을 넘을 수 있어서, CLI와 MCP 서버는 heap 크기를 직접
지정하지 않았으면 시스템 메모리의 3/4(최대 16GB)로 다시 실행한다.

### 2. Backend API 추출 (Spring Boot)

```bash
node packages/cli/dist/bin.js extract-backend ./backend      # -o backend.json 으로 JSON도 저장
```

Endpoint(method, path, handler, path/query/header 파라미터, request body, response 타입)와 DTO의 JSON 필드
(상속, record, getter, `@JsonProperty`, `@JsonIgnore`, `@JsonNaming`, nullable, enum, `Page<T>`)를 추출한다.
backend를 빌드하지 않고 소스만 읽는다.

### 3. Contract check — frontend가 실제 API와 맞는가

```bash
node packages/cli/dist/bin.js check                                   # 전체
node packages/cli/dist/bin.js index ./frontend --changed-since origin/main --check   # 바뀐 TS 파일만: 갱신 → API 목록 → 검사
```

```text
Tacet contract check: FAIL  (scope: 1 file)

APIs checked (1):
  ✗ GET /products/{id}  1 call site, 1 field read  1 issue

Issues: 1 error, 0 warnings, 0 info

  ERROR   src/pages/Product.tsx:5:10  FIELD_NOT_FOUND
          ProductResponse has no field `cost` (reading `cost` from GET /products/{id})
          product.cost
```

없는 endpoint, method 불일치, 없는 필드(오타 제안), 배열/객체 혼동, body 없는 응답 읽기, request body/query key 불일치를
검사한다. `--format json`, `--fail-on error|warning|never`(기본 error → exit 1).

### 4. Impact — 바꾸면 어디까지 영향이 가나 (실제 변경 없이)

```bash
tacet impact --api "GET /users/{id}"        # 호출 위치, 읽는 필드, 파일·컴포넌트
tacet impact --file src/api/user.ts         # 이 파일의 API, client 함수 호출처, import하는 파일, blast radius
tacet impact --field UserResponse.name      # 이 필드를 반환하는 모든 endpoint와 읽는 위치
tacet impact --search profile               # 통합 검색
tacet impact --summary                      # API/파일을 영향도 순으로, 안 쓰이는 endpoint
tacet graph -o .tacet/graph.html          # 전체 인터랙티브 그래프
tacet impact --file src/api/user.ts -f html -o impact.html   # 특정 질의의 그래프
tacet impact --api "GET /users/{id}" -f mermaid              # PR 코멘트용 Mermaid
```

HTML 그래프는 API → 응답 필드 → 함수/컴포넌트 → 파일의 계층 그래프다. 노드를 클릭하면 연결된 전체를 추적하고,
검색과 종류 필터, 검색 가능한 목록을 제공한다. 외부 리소스 없이 단일 파일로 동작한다.

### 4-1. Ontology — 어떤 페이지가 어떤 API와 연결되어 있나

```bash
tacet ontology                                  # .tacet/ontology.html (인터랙티브 탐색기)
tacet ontology -f text                          # 페이지 → API, API → 페이지 목록
tacet ontology --focus "/users/:id" -f mermaid  # 특정 페이지/컴포넌트/API/DTO 주변만
tacet ontology -f turtle -o tacet.ttl           # RDF/OWL (triple store, SPARQL)
tacet ontology -f json                          # entities + triples + page→API 행
```

```text
Pages → APIs (3):
  /users/:id  UserPage  src/App.tsx
    ✓ GET /users/{id}
        via UserPage → getUser
        reads age, name
```

프로젝트를 엔티티(Page, Component, Hook, ApiClient, Function, Endpoint, Controller, Dto, DtoField, Enum, File)와
관계(`showsComponent`, `renders`, `calls`, `requests`, `reads`, `handledBy`, `accepts`, `returns`, `hasField`, `typedAs`,
`definedIn`)로 표현한다. 관계마다 근거 코드 위치가 붙고, `usesApi`(페이지 → API)는 이 관계들을 따라가 추론한다.
페이지가 실제로 요청하는 API만 연결하며, 공용 helper(`formatDate(row.createdAt)`)가 다른 API 데이터를 읽었다는 이유만으로는 연결하지 않는다.
읽는 응답 필드는 실제 DTO 필드(`Profile.email`)에 연결된다.

페이지는 React Router(`<Route>` JSX, route 객체, `lazy`), vue-router(`{ path, component: () => import("./X.vue") }`,
다른 파일의 route 배열을 `children: [...routes]`로 합친 경우 포함), Next.js(`pages/`, `app/**/page.tsx`), Remix/React Router
`app/routes/`에서 찾는다. 인식하지 못하는 router는 `tacet.config.json`의 `routes`로 지정하고, router가 하나도 없으면
`pages/`·`views/`·`screens/` 디렉터리의 export된 컴포넌트를 (경로 없는) 페이지로 본다.

HTML 탐색기: class별 레인 그래프(클래스·관계 필터, 클릭 시 연결 추적과 근거), Page × API 매트릭스, triple 표, schema 다이어그램.

### 5. Backend API 변경 → Frontend 영향

```bash
# index에 저장된 계약(= frontend가 작성된 기준)과 지금의 backend 소스를 비교
tacet analyze --backend ./backend               # --save 로 새 계약을 기준으로 저장
# git ref 두 개를 비교 (head 생략 = working tree). backend가 안 바뀌었으면 바로 PASS
tacet diff --base origin/main --backend ./backend -f markdown -o api-changes.md
```

```text
Tacet API change report: FAIL

Changed APIs: 8   Breaking changes: 35   Frontend impact: 9 definite, 2 likely, 4 possible

GET /users/{id}  [changed]  FAIL
  ! Response field `name` was removed
  ! Response `age` type changed: int → String
  ! Response field `profile.email` may now be null
  ! Response `tags` changed from an array to an object/value (String[] → String)
    Response field `username` was added
  Related files: 4   Definite: 4   Likely: 1   Possible: 3
    DEFINITE src/components/UserCard.tsx:4  UserCard  user.name
             Reads `name`; `name` was removed from the response
    LIKELY   src/pages/User.tsx:19  UserPage  user.age
             Uses `age`, which may now be null; Reads `age`; `age` changed int → String
    POSSIBLE src/pages/User.tsx:30  loadProfile  value.name
             Reads `name`; ... (value passed through a function Tacet could not follow)

PUT /users/{id}  [moved → PUT /users/{id}/profile]  FAIL
    DEFINITE src/api/user.ts:12  userApi.updateUser  api.put(`/users/${id}`, body)
```

감지하는 변경: endpoint 추가/삭제/이동(같은 handler), parameter 추가·삭제·타입·필수 여부, request body와 그 필드
(필수 필드 추가 등), response 필드 삭제·타입 변경(JSON 타입이 같으면 non-breaking)·nullable 변경·배열↔객체 변경,
enum 값 추가·삭제. 영향은 `DEFINITE`(확실) / `LIKELY`(대부분 깨짐) / `POSSIBLE`(연결은 있으나 증명 불가)로 나뉜다.
`--fail-on definite|likely|possible|never`(기본 definite), `--format text|json|markdown`.

### 6. AI 검증 (선택)

정적 분석이 확정하지 못한 위치(LIKELY / POSSIBLE)만 AI가 다시 본다. DEFINITE는 AI에 보내지 않고 뒤집지도 않는다.

```bash
export ANTHROPIC_API_KEY=...          # 또는 `ant auth login`
tacet verify --backend ./backend                          # 저장된 계약 대비
tacet verify --backend ./backend --base origin/main -f markdown
# --provider anthropic (기본) --model <id> (기본 claude-opus-5) --effort low|medium|high|xhigh|max
```

- AI에는 **해당 코드 주변 몇 줄 + 데이터를 가져온 호출부 + 변경 전/후 응답 스키마**만 보낸다. repository 전체는 보내지 않는다.
- 응답은 구조화된 출력(JSON schema)으로 받으며, 판정마다 file:line과 코드 인용을 요구한다. 보낸 코드에 없는 근거를 대면 그 판정은 `UNKNOWN`으로 강등된다.
- 최종 결과: DEFINITE가 있으면 FAIL, 그 외에는 AI FAIL → FAIL, 전부 PASS → PASS, 나머지(WARNING/UNKNOWN/검증 실패) → WARNING. 정적 결과(`staticResult`)도 함께 남는다.
- 자격 증명이 없거나 호출이 실패해도 리포트는 정적 결과로 나오고 오류만 표시된다.
- Claude Opus 5 요청에는 서버 측 refusal fallback(`fallbacks: "default"`)이 켜져 있다. 거절되면 같은 호출 안에서 fallback 모델로 재시도한다.

### 7. CI/CD

GitHub Actions (이 저장소의 composite action, `examples/github-workflow.yml`):

```yaml
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  tacet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: <owner>/tacet@v1
        with: { frontend: frontend, backend: backend }
```

AI 검증을 켜려면 `with: { ai-provider: anthropic }`와 `env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }`를 추가한다.

PR마다 (1) backend API 변경이 영향을 주는 frontend 코드, (2) 변경된 frontend 파일의 계약 위반을 검사해서 job summary와
PR 코멘트(갱신)로 남기고, 기준 이상이면 job을 실패시킨다. 다른 CI에서는 `scripts/tacet-ci.sh`를 그대로 쓴다
(`TACET_FRONTEND`, `TACET_BACKEND`, `TACET_BASE`, `TACET_FAIL_ON`, `TACET_CHECK_FAIL_ON`).

### 8. MCP / 라이브러리

같은 기능을 MCP tool로 제공한다. tool: `index_frontend`, `extract_backend`, `check_contract`,
`analyze_api_changes`, `diff_api_changes`, `verify_api_changes`, `impact_of_api`,
`impact_of_file`, `impact_of_field`, `search`, `impact_summary`, `render_graph`, `page_apis`, `ontology`.

**독립 MCP 서버 (stdio)** — Claude Desktop / Claude Code 등에 바로 연결:

```json
{
  "mcpServers": {
    "tacet": {
      "command": "node",
      "args": ["/path/to/tacet/packages/mcp/dist/bin.js",
               "--index", "/path/to/project/.tacet/index.db",
               "--frontend", "/path/to/project/frontend",
               "--backend", "/path/to/project/backend"]
    }
  }
}
```

**기존 TypeScript fastmcp 서버에 추가** (`packages/mcp/examples/fastmcp-server.ts`):

```ts
import { FastMCP } from "fastmcp";
import { addTacetTools } from "@tacet-api/mcp";

const server = new FastMCP({ name: "my-dev-tools", version: "1.0.0" });
addTacetTools(server, { frontendDir: "./frontend", backendDir: "./backend", prefix: "tacet_" });
await server.start({ transportType: "stdio" });
```

**기존 Python FastMCP 서버에 추가** (`python/`, CLI의 `--format json`을 사용):

```python
from fastmcp import FastMCP
from tacet.fastmcp import register_tools

mcp = FastMCP("my-server")
register_tools(mcp, frontend_dir="./frontend", backend_dir="./backend", prefix="tacet_")
```

다른 MCP 프레임워크에는 `createTacetTools()`(zod schema + JSON 반환 handler)를, 코드에서 직접 쓸 때는
`TacetWorkspace`(`@tacet-api/cli`)를 사용한다. workspace는 파싱된 frontend를 메모리에 유지해서 반복 갱신이 빠르다.

### tacet.config.json

```json
{
  "apiClientMap": {
    "productApi.getProduct": { "method": "GET", "path": "/products/{id}" }
  },
  "linking": {
    "frontendBasePath": "/api",
    "backendBasePath": "",
    "pathRewrites": { "/api/console": "" }
  },
  "envFiles": ["apps/admin-web/.env"],
  "env": { "VITE_API_PREFIX": "/api/admin" },
  "routes": { "/users/:id": "src/pages/User.tsx#UserPage" }
}
```

- `apiClientMap`: endpoint를 자동 추론할 수 없는 API client(예: 제네릭 `request({ method, url })` 헬퍼)의 명시적 매핑.
- `linking`: frontend HTTP client의 baseURL, backend context-path 등 prefix 차이. `pathRewrites`는 proxy/API gateway가
  backend로 넘기기 전에 바꾸는 prefix(긴 prefix 우선).
- `envFiles` / `env`: axios `baseURL`에 쓰이는 build-time 환경변수(`import.meta.env.X`, `process.env.X`). `envFiles`는
  frontend root 기준 dotenv 파일이고 `env`가 우선한다. 같은 코드를 여러 앱(예: admin/user)으로 빌드하면 앱별 config로
  각각 검사한다.
- `routes`: 자동 인식되지 않는 router의 페이지. `경로 → 파일[#컴포넌트]` (컴포넌트 생략 시 default export).

## 로드맵

| Phase | 내용 | 상태 |
|---|---|---|
| 1 | TypeScript AST 분석 + Index | ✅ |
| 2 | Java Spring API 분석 (JavaParser) | ✅ |
| 3 | Backend API ↔ Frontend 호출 연결, contract check, incremental index, 영향 범위 탐색·그래프 | ✅ |
| - | Ontology: 페이지 ↔ 컴포넌트 ↔ API ↔ Controller ↔ DTO 관계 (HTML, RDF/Turtle, MCP) | ✅ |
| 4 | API 변경 감지 | ✅ |
| 5 | Static impact analysis (DEFINITE / LIKELY / POSSIBLE) | ✅ |
| 6 | AI verification (provider 추상화, Anthropic 구현, evidence 검증) | ✅ |
| 7 | Git diff / CI integration (GitHub Action, CI script, Markdown 리포트) | ✅ |
| - | Library API / MCP (stdio 서버, TS fastmcp, Python FastMCP) | ✅ |
| - | 배포: npm, PyPI, Gradle/Maven 플러그인 | ✅ (게시 준비 완료) |

## 릴리스

`node scripts/set-version.mjs <version>` → 커밋 → `git tag v<version> && git push --tags`. 태그가 push되면
`.github/workflows/release.yml`이 npm, PyPI, Maven Central, Gradle Plugin Portal에 게시한다. 최초 설정은 [RELEASING.md](./RELEASING.md).

## 새 언어 추가

Core는 언어를 모른다. 새 언어는 공통 IR(`packages/core/src/ir/types.ts`)로 된 Manifest를 출력하는 extractor만 만들면 된다.

- JS/TS로 작성: `LanguageExtractor` 인터페이스 구현
- 다른 언어로 작성: `<command> <rootDir>` 실행 시 stdout에 Manifest JSON을 출력하는 실행 파일 → `SubprocessExtractor`로 연결
