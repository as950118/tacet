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
| Python / FastMCP | `pip install "tacet-api[fastmcp]"` (import 이름 `tacet`) |
| Gradle | `plugins { id("io.github.as950118.tacet") version "0.1.2" }` |
| Maven | `io.github.as950118:tacet-maven-plugin:0.1.2` |

모든 형태가 같은 CLI(`@tacet-api/cli`)를 실행한다. Python과 Gradle/Maven 플러그인은 `tacet`가 PATH에 없으면
같은 버전을 `npx`로 자동 실행하므로, 실행 환경에 Node.js 22.13+(와 backend 분석용 Java 17+)만 있으면 된다.

### Gradle

```kotlin
plugins { id("io.github.as950118.tacet") version "0.1.2" }

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
  <groupId>io.github.as950118</groupId>
  <artifactId>tacet-maven-plugin</artifactId>
  <version>0.1.2</version>
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
backend를 빌드하지 않고 소스만 읽는다. 서비스 간 호출(`@FeignClient`, `@HttpExchange` client), Spring Cloud Gateway
라우트(`spring.cloud.gateway.routes`), `server.servlet.context-path`도 함께 읽는다(아래 4-3).

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
대부분의 페이지가 쓰는 API(권한 조회, 아이콘 fetch 등)는 "공통 API"로 표시되어 기본 보기와 관련 페이지 계산에서 빠지고,
각 페이지에는 API를 함께 쓰는 "관련 페이지" 순위가 붙는다(`tacet relations --page`에도 나온다). 서로 렌더/호출하는
컴포넌트는 그래프에서 노드 하나로 합쳐진다. 페이지가 실제로 요청하는 API만 연결하며, 공용 helper(`formatDate(row.createdAt)`)가 다른 API 데이터를 읽었다는 이유만으로는 연결하지 않는다.
읽는 응답 필드는 실제 DTO 필드(`Profile.email`)에 연결된다.

페이지는 React Router(`<Route>` JSX, route 객체, `lazy`), vue-router(`{ path, component: () => import("./X.vue") }`,
다른 파일의 route 배열을 `children: [...routes]`로 합친 경우 포함), Next.js(`pages/`, `app/**/page.tsx`), Remix/React Router
`app/routes/`에서 찾는다. 인식하지 못하는 router는 `tacet.config.json`의 `routes`로 지정하고, router가 하나도 없으면
`pages/`·`views/`·`screens/` 디렉터리의 export된 컴포넌트를 (경로 없는) 페이지로 본다.

HTML 탐색기: class별 레인 그래프, Page ↔ API 탭, triple 표, schema 다이어그램. Page ↔ API 탭은 "Pages → APIs" / "APIs → pages" 목록(영역별 그룹, 필터, broken만 보기)과
선택한 항목의 API(또는 페이지)를 broken 먼저 보여주고, 펼치면 호출 경로와 읽는 필드가 나온다.
목록은 경로 트리로 drill down 한다: 페이지는 `/aws` → `/aws/compute` → …, API는 method·role·version을 뺀 경로
(`inventory` → `aws` → `compute` …). 상단 breadcrumb으로 범위를 오가고, 아무것도 고르지 않으면 그 범위의 요약
(이 페이지들이 쓰는 API, 또는 이 API들을 쓰는 페이지, broken 먼저·빈도순)이 나온다. 그래프 탭의 페이지 목록도 같다. 작은 프로젝트에서는 Page × API 매트릭스도 볼 수 있다. 그래프는 큰 프로젝트에서 전체를 그리지 않고
왼쪽 페이지 목록이나 검색(종류별 추천)에서 고른 하나를 중심으로 위·아래로 연결된 것만 다시 배치한다(깊이 1/2/3/전체, 이동 경로는
breadcrumb). 기본값 "API paths only"는 API까지 이어지지 않는 UI 컴포넌트와 공용 formatter의 `reads` 연결을 숨긴다. 노드 클릭은
경로 강조, 더블클릭은 그 노드로 재배치. 작은 프로젝트(150개 이하)는 처음부터 전체 그래프를 보여준다.

### 4-2. 관계는 index DB에 저장된다

`index`/`extract-backend`가 index를 갱신할 때마다 관계(ontology)를 다시 계산해 같은 index DB(SQLite 파일 또는 PostgreSQL,
[4-4](#4-4-index-db--sqlite-파일-또는-postgresql))의 `entities`, `relations`, `page_apis` 테이블에 저장한다. 다시 분석하지 않고
바로 조회할 수 있다.

```bash
tacet relations --page "/users/:id"                      # 이 페이지가 쓰는 API (호출 경로, 읽는 필드)
tacet relations --api "GET /users/{id}"                  # 이 API를 쓰는 페이지
tacet relations --subject UserPage --predicate renders   # 관계 직접 조회 (subject / predicate / object, -f json)
```

```sql
-- 모든 행은 project 컬럼을 가진다 (--project 생략 시 'default')
-- 이 API를 쓰는 페이지
SELECT e.label, p.via, p.fields FROM page_apis p JOIN entities e ON e.project = p.project AND e.id = p.page
WHERE p.project = 'default' AND p.api_key = 'GET /users/{id}';
-- 백엔드에 없는 API를 쓰는 페이지
SELECT e.label, p.api_key, p.status FROM page_apis p JOIN entities e ON e.project = p.project AND e.id = p.page
WHERE p.project = 'default' AND p.status IN ('not-found', 'method-mismatch');
-- 어떤 컴포넌트를 렌더링하는 곳
SELECT s.label, s.file FROM relations r
JOIN entities s ON s.project = r.project AND s.id = r.subject JOIN entities o ON o.project = r.project AND o.id = r.object
WHERE r.project = 'default' AND r.predicate = 'renders' AND o.label = 'UserCard';
```

### 4-3. 미사용 API — 아무도 부르지 않는 endpoint

```bash
tacet unused                                   # 이 index의 frontend 기준
tacet -i admin.db unused --also user.db        # 같은 backend를 쓰는 frontend가 여럿이면 함께 (admin 앱 + user 앱)
tacet unused -f markdown -o unused.md          # 컨트롤러별 보고서 / -f csv (--all: 사용 중인 것까지) / -f json
```

endpoint마다 호출자를 모아 분류한다.

| usage | 의미 |
|---|---|
| `frontend` | frontend가 호출한다 |
| `service` | 다른 backend 서비스가 Feign / `@HttpExchange` client로 호출한다 (`/api/user/v1/iam/users/ids` → context path `/api`를 빼고 연결) |
| `client-declared` | client 메서드는 있지만 그 메서드를 부르는 코드가 없다 |
| `unused` | 호출자를 찾지 못했다 |

같은 path의 다른 method가 쓰이는지(`GET`은 쓰고 `DELETE`는 안 씀), gateway 라우트가 이 endpoint까지 닿는지
(`Path` predicate에 `RewritePath`/`StripPrefix`/`PrefixPath`를 적용, `{userType:admin|user}` 같은 경로변수 제약 반영)도
함께 나온다. 라우트가 닿지 않는 미사용 endpoint는 외부에서 부를 수 없으니 내부 전용이거나 이 저장소 밖에서 호출된다.

HTML 탐색기(`tacet ontology`)의 **Unused APIs** 탭에서도 볼 수 있다. 상단 막대가 프론트 사용 / 서비스 전용 / 미사용 비율이고
(누르면 그 종류만), 왼쪽은 경로(`/inventory` → `/inventory/aws` …)나 컨트롤러별 미사용 개수와 막대, 오른쪽은 컨트롤러로 묶은
endpoint 목록(다른 method 사용 여부, gateway 미노출, 호출하는 Feign client)이다. 다른 frontend index도 합치려면
`tacet -i admin.db ontology --also user.db`.

삭제 후보 목록이지 삭제해도 된다는 판정은 아니다. 분석한 코드 밖의 호출자(다른 저장소, 배치, 외부 시스템, URL을 직접
조립하는 RestTemplate/WebClient)와 URL을 정적으로 알 수 없는 frontend 호출은 보이지 않는다(보고서에 개수가 나온다).
운영 접근 로그와 교차 확인할 것.

### 4-4. Index DB — SQLite 파일 또는 PostgreSQL

index는 기본적으로 `.tacet/index.db`(SQLite, 설치 없이 동작)에 저장된다. `--index`(또는 `$TACET_INDEX`)에 PostgreSQL URL을
주면 외부 DB에 저장하고, `--project`(또는 `$TACET_PROJECT`)로 한 DB에 여러 프론트엔드 앱을 나눠 담는다.

```bash
export TACET_INDEX='postgres://tacet:****@db.internal:5432/tacet?schema=tacet'   # 테이블은 schema(기본 tacet)에 생성
tacet -p admin index ./admin-web && tacet -p admin extract-backend ./backend
tacet -p shop  index ./shop-web  && tacet -p shop  extract-backend ./backend
tacet projects                                     # DB에 있는 프로젝트와 마지막 인덱싱 시각
tacet -p admin unused --also-projects shop         # 두 앱 모두에서 안 쓰는 API
```

- 비밀번호가 프로세스 목록에 보이지 않도록 URL은 `--index`보다 `$TACET_INDEX`로 넘기는 것을 권장한다(Python 클라이언트는 자동으로 그렇게 한다). 출력에는 `***`로 가려진다.
- 같은 프로젝트를 동시에 인덱싱하면 PostgreSQL advisory lock으로 순서대로 처리된다.
- 저장 계층은 `IndexStore` 인터페이스(`@tacet-api/core`) 뒤에 있어서 CLI, MCP, HTTP API가 DB 종류를 모른다. index는 소스에서 다시 만들 수 있는 파생 데이터라 스키마 버전이 바뀌면 마이그레이션 대신 다시 생성한다(PostgreSQL에서는 지정한 schema 안의 Tacet 테이블만).

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
`impact_of_file`, `impact_of_field`, `search`, `impact_summary`, `render_graph`, `page_apis`, `relations`, `unused_apis`, `ontology`.

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

### 9. HTTP API (`tacet serve`)

index DB의 모든 프로젝트를 REST API로 제공한다. 대시보드, 다른 서비스, 사내 포털에서 MCP 없이 조회할 때 쓴다.
라우트 전체는 `GET /openapi.json`(OpenAPI 3.1)에 있다.

```bash
TACET_API_TOKEN=... tacet serve --port 4318 --allow-dir /srv/repos     # 기본 127.0.0.1, --host 0.0.0.0은 토큰 필수
curl -H "Authorization: Bearer $TACET_API_TOKEN" localhost:4318/projects/admin/pages?api=GET%20/users
```

| Method | Path | 내용 |
|---|---|---|
| GET | `/health`, `/openapi.json` | 상태·버전·DB 종류 / API 문서 (토큰 불필요) |
| GET | `/projects` | 프로젝트 목록과 마지막 인덱싱 시각 |
| GET / DELETE | `/projects/{p}` | 프로젝트 index 요약 / 삭제 |
| POST | `/projects/{p}/frontend` | `{dir, files?, changedSince?, config?, check?}` 프론트엔드 인덱싱 |
| POST | `/projects/{p}/backend` | `{dir}` Spring Boot 계약 추출 |
| POST | `/projects/{p}/analyze` | `{dir, save?}` 저장된 계약 대비 backend 변경 영향 |
| GET | `/projects/{p}/pages` | 페이지 ↔ API (`?page=`, `?api=`) |
| GET | `/projects/{p}/relations` | `?page=` / `?api=` / `?subject=&predicate=&object=` |
| GET | `/projects/{p}/ontology` | `?focus=&depth=&format=json\|mermaid\|turtle\|html` |
| GET | `/projects/{p}/check` | 계약 검사 (`?files=a,b`, `?changedSince=`) |
| GET | `/projects/{p}/impact` | `?api=` / `?file=` / `?field=` (없으면 전체 순위), `&graph=` |
| GET | `/projects/{p}/search`, `/graph`, `/unused` | 검색 `?q=` / 영향 그래프 / 미사용 API. 같은 backend로 인덱싱한 다른 프로젝트(예: admin·user 앱)의 프론트엔드도 기본으로 함께 계산한다. 직접 지정은 `?also=`, 이 프로젝트만 계산은 `?alone` |

- 인덱싱 엔드포인트는 서버의 경로를 읽으므로 `--allow-dir`(기본: 현재 디렉터리) 안의 경로만 받는다. 같은 프로젝트의 쓰기는 순서대로 처리된다.
- `--read-only`(또는 `TACET_READ_ONLY=true`)면 조회 라우트만 연다. 인덱싱·삭제는 403으로 거부한다. 데이터를 다른 곳(로컬 CLI, CI)에서 넣는 공개 서버용이다.
- 배포(Supabase + Render + Vercel 대시보드 `web/`)는 [DEPLOY.md](./DEPLOY.md) 참고.
- 브라우저에서 호출하려면 `--cors <origin>`. 라이브러리로는 `createTacetApiServer()`(`@tacet-api/cli`)의 `handle(req, res)`를 기존 Node 서버에 붙일 수 있다.

#### 회원 (`--accounts`, 개발 중)

`--accounts`(또는 `TACET_ACCOUNTS=true`)를 켜면 가입·로그인과 워크스페이스·멤버·초대 라우트가 추가된다. 계정은 index DB에 함께 저장된다. 워크스페이스 단위의 프로젝트 권한은 아직 개발 중이다.

```bash
tacet platform migrate                              # 계정 테이블 생성·업그레이드 (serve --accounts도 시작할 때 실행한다)
TACET_API_TOKEN=... tacet serve --accounts
curl -X POST localhost:4318/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"at least 10 chars"}'        # → {user, token, expiresAt}
curl -H "Authorization: Bearer <token>" localhost:4318/me
```

| Method | Path | 내용 |
|---|---|---|
| POST | `/auth/signup` | `{email, password, displayName?}` 가입하고 바로 로그인한다. 비밀번호는 10~256자. 이미 가입된 이메일이면 409. |
| POST | `/auth/login` | `{email, password}` 세션 토큰을 발급한다. 15분에 실패 10회가 넘으면(IP·이메일별) 429와 `Retry-After`. |
| POST | `/auth/logout` | 현재 세션을 끝낸다(세션 토큰 필요). |
| GET | `/me` | 로그인한 사용자(세션 토큰 필요). |
| GET, POST | `/workspaces` | 내 워크스페이스 목록과 내 역할 / `{name, slug?}`로 만들기(만든 사람이 owner). |
| GET, PATCH, DELETE | `/workspaces/{ws}` | 조회 / 이름·slug 변경(admin 이상) / 삭제(owner). |
| GET | `/workspaces/{ws}/members` | 멤버와 역할. `PATCH`·`DELETE …/members/{userId}`로 역할 변경(`{role}`)·제거. |
| POST | `/workspaces/{ws}/leave`, `/workspaces/{ws}/transfer` | 탈퇴 / `{userId}`에게 소유권 이전(owner는 admin이 된다). |
| GET, POST | `/workspaces/{ws}/invites` | 대기 중인 초대 / `{email, role}`로 초대(admin 이상). 토큰은 이 응답에서 한 번만 준다. `DELETE …/invites/{inviteId}`로 취소. |
| POST | `/invites/accept` | `{token}` 초대를 수락한다. 초대 이메일과 계정 이메일이 달라도 된다. |

- 세션 토큰은 30일 동안 유효하고, 쓸 때마다 연장된다. 서버는 토큰의 해시만 저장한다. 만료된 세션은 시작할 때와 매시간 지운다.
- 세션 토큰으로는 기존 `/projects` 라우트를 쓸 수 없다. 이 라우트는 여전히 서버 토큰(`TACET_API_TOKEN`)이 필요하다. 서버 토큰이 없는 로컬 서버는 예전처럼 누구에게나 열려 있다.
- 가입하면 개인 워크스페이스가 함께 만들어지고 그 사용자가 owner가 된다. 역할은 owner > admin > member > viewer다. owner가 아니면 자기보다 낮은 역할만 부여·변경·제거할 수 있고, 마지막 owner는 강등·제거·탈퇴할 수 없다(409). 멤버가 아닌 워크스페이스는 404다. 초대 토큰은 7일 동안 한 번만 쓸 수 있고 해시만 저장된다. 자세한 명세는 `.company-os/projects/apilens-platform/api/API-0001-workspaces.md`에 있다.
- 리버스 프록시(Render 등) 뒤에서는 `--trust-proxy`(`TACET_TRUST_PROXY=true`)를 켜야 로그인 제한이 실제 클라이언트 IP 기준으로 동작한다.

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
  "commonApis": { "share": 0.25, "minPages": 8, "include": [], "exclude": [] },
  "requestHelpers": { "callApiWithConvertedUrl": { "instance": 0, "method": 1, "url": 2 } },
  "routes": { "/users/:id": "src/pages/User.tsx#UserPage" }
}
```

- `apiClientMap`: endpoint를 자동 추론할 수 없는 API client(예: 제네릭 `request({ method, url })` 헬퍼)의 명시적 매핑.
- `linking`: frontend HTTP client의 baseURL, backend context-path 등 prefix 차이. `pathRewrites`는 proxy/API gateway가
  backend로 넘기기 전에 바꾸는 prefix(긴 prefix 우선).
- `commonApis`: "공통 API"(대부분의 페이지가 쓰는 권한 조회, 아이콘 fetch 등) 기준. 전체 페이지의 `share`(기본 0.25) 이상이면서
  `minPages`(기본 8) 이상 페이지가 쓰는 API가 공통이고, `include`/`exclude`(예: `"GET /admin/v1/auth"`)로 강제할 수 있다.
  index DB·CLI·MCP가 이 기준을 쓴다. HTML 탐색기 상단의 "Common APIs" 패널에서는 비율·최소 페이지 수·API별 공통 여부를
  개인 설정으로 바꿀 수 있고, 이 설정은 그 브라우저에만 저장된다(localStorage, 프로젝트별).
- `requestHelpers`: 인스턴스·메서드·URL을 인자로 받는 범용 요청 함수. 예: `callApi(awsApiInstance, "get", "/vpcs")` →
  `{ "callApi": { "instance": 0, "method": 1, "url": 2 } }`(0부터 센 인자 위치, `method`는 고정 메서드 문자열도 가능).
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
| - | 외부 index DB (PostgreSQL, 프로젝트별 분리) + HTTP API (`tacet serve`, OpenAPI) | ✅ |
| - | 배포: npm, PyPI, Gradle/Maven 플러그인 | ✅ (게시 준비 완료) |

## 릴리스

`node scripts/set-version.mjs <version>` → 커밋 → `git tag v<version> && git push --tags`. 태그가 push되면
`.github/workflows/release.yml`이 npm, PyPI, Maven Central, Gradle Plugin Portal에 게시한다. 최초 설정은 [RELEASING.md](./RELEASING.md).

## 새 언어 추가

Core는 언어를 모른다. 새 언어는 공통 IR(`packages/core/src/ir/types.ts`)로 된 Manifest를 출력하는 extractor만 만들면 된다.

- JS/TS로 작성: `LanguageExtractor` 인터페이스 구현
- 다른 언어로 작성: `<command> <rootDir>` 실행 시 stdout에 Manifest JSON을 출력하는 실행 파일 → `SubprocessExtractor`로 연결
