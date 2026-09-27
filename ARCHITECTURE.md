# Tacet Architecture

Tacet는 Backend API 변경이 기존 Frontend 코드를 깨뜨릴 가능성을 배포 전에 탐지한다.
분석은 세 단계로 명확히 분리된다.

```text
1. API 변경을 정확하게 탐지            (Backend extractor + Diff engine)
2. 변경 API ↔ Frontend 코드를 정적 추적  (Frontend index + Impact engine)
3. 정적으로 확정하기 어려운 부분만 AI 검증 (AI verification layer)
```

AI는 핵심 분석 엔진이 아니라 Verification Layer이며, AI 없이도 1~2단계 결과는 항상 나온다.

---

## 1. Architecture

```text
                      ┌──────────────────────────┐
                      │    tacet CLI (Node/TS)  │
                      └────────────┬─────────────┘
                                   │
                      ┌────────────▼─────────────┐
                      │  @tacet-api/core            │
                      │  (language-agnostic)      │
                      │  - IR schema              │
                      │  - Index store (SQLite)   │
                      │  - Extractor protocol     │
                      │  - Diff / Impact  (P4/P5) │
                      │  - AI provider    (P6)    │
                      └───┬──────────────────┬────┘
                          │                  │
          ┌───────────────▼──────┐   ┌───────▼──────────────────┐
          │ extractor-typescript │   │ extractor-java  (Phase 2) │
          │ in-process, ts-morph │   │ subprocess, JavaParser JAR│
          └──────────────────────┘   └───────────────────────────┘
```

### 언어 확장 구조 (Extractor Protocol)

Core는 특정 언어를 모른다. 모든 extractor는 공통 IR(`packages/core/src/ir/types.ts`)로 된
**Manifest**를 산출하고, Core는 Manifest만 소비한다.

| 종류 | 실행 방식 | 예 |
|---|---|---|
| In-process | `LanguageExtractor` 인터페이스를 구현한 JS/TS 모듈 | TypeScript (ts-morph) |
| Out-of-process | `<command> <args...> <rootDir>` 실행 → stdout에 Manifest JSON 출력 | Java (JavaParser JAR), 추후 Python/Go/Kotlin 등 |

Out-of-process extractor는 `SubprocessExtractor`(`packages/core/src/extractor/subprocess-extractor.ts`)로
연결된다. 새 언어 지원 = 해당 언어로 extractor를 작성해 IR JSON을 출력하게 하는 것. Core 수정은 필요 없다.

## 2. Module structure

```text
packages/
├── core/                  언어 비종속 엔진
│   └── src/
│       ├── ir/            IR 타입 (Frontend + Backend manifest)
│       ├── index-store/   SQLite schema + repository
│       ├── extractor/     LanguageExtractor 인터페이스, SubprocessExtractor
│       ├── analysis/      Phase 3: 연결(link), contract check, impact 질의, graph
│       ├── report/        graph renderer (Mermaid, 인터랙티브 HTML)
│       ├── config.ts      tacet.config.json (apiClientMap, linking)
│       ├── path.ts        path 정규화 (frontend/backend 공용)
│       └── ai/            Phase 6: AiProvider 인터페이스, prompt, 검증 오케스트레이션
├── extractor-typescript/  Phase 1: ts-morph 기반 Frontend 분석
│   └── src/
│       ├── analyzer.ts    데이터 흐름 추적 (symbol 기반)
│       ├── extractor.ts   Manifest 생성
│       └── endpoint.ts    URL 표현식 → path pattern, query/body key 추출
├── extractor-java/        Phase 2: Spring backend 분석
│   ├── jvm/               JavaParser 기반 extractor (Gradle → tacet-java-extractor.jar)
│   └── src/               JavaExtractor (JAR를 subprocess로 실행)
├── ai-anthropic/          Phase 6: Claude provider (@anthropic-ai/sdk)
├── mcp/                   MCP: stdio 서버, fastmcp adapter, tool 정의 (python/ 은 Python 바인딩)
└── cli/                   tacet 바이너리
    └── src/
        ├── workspace.ts   TacetWorkspace — CLI/MCP가 공유하는 라이브러리 진입점
        ├── program.ts     커맨드 정의
        └── format.ts      텍스트 출력
```

`packages/extractor-java/`는 두 부분으로 되어 있다: `jvm/`(Gradle, JavaParser → fat JAR)과 이를 실행하는
Node 래퍼 `src/`(`JavaExtractor`, `SubprocessExtractor` 사용).

## 3. Data model (IR)

Frontend (Phase 1 구현):

| 타입 | 주요 필드 |
|---|---|
| `FileInfo` | path, imports(**resolvedFile**: tsconfig paths까지 해석된 프로젝트 파일), exports |
| `FunctionInfo` | id, name, params, returnType, calls, containingComponent |
| `ApiCallInfo` | endpointPattern, method, calleeExpression, **resolution**, **wrapperFunctionId**, callerFunctionId, location, arguments, **request**(queryKeys, bodyKeys), returnVarType, code |
| `PropertyAccessInfo` | apiCallId, object, **path (response body 기준)**, **flow**, location, containingFunctionId, containingComponent, code |

- `resolution`: `direct`(axios/fetch 직접 호출) · `wrapper`(API 호출 결과를 반환하는 함수 호출, 예: `getUser(id)`) · `config`(apiClientMap)
- `wrapperFunctionId`: wrapper 호출이 거치는 API client 함수. graph에서 `API → getUser → UserPage` 사슬과 "이 파일의 client 함수를 누가 쓰나"에 사용.
- `request`: 정적으로 알 수 있는 query key(URL의 `?a=`, axios `params`)와 body key(object literal). 알 수 없으면 `null` — 추측하지 않는다.
- `path`: **응답 body 기준 경로**. `res.data.user.name`(axios)이나 `(await res.json()).user.name`(fetch) 모두 `["user","name"]`로 저장된다. 배열 원소는 `"[]"`. 따라서 Phase 5에서 DTO 필드와 바로 비교할 수 있다.
- `flow`: `direct`(응답 body임이 증명됨) · `derived`(추적 불가한 함수를 거침, 예: `transform(user).name`) → Phase 5에서 DEFINITE/POSSIBLE 판정의 근거가 된다.

Backend: `EndpointInfo`, `DtoInfo`, `DtoFieldInfo`, `EnumInfo`, `ParamInfo`, 재귀 `TypeRef`(scalar/dto/enum/array/map/typeParameter/unknown).

## 4. TypeScript AST 분석 방법 (구현됨)

ts-morph로 프로젝트를 로드한다(`tsconfig.json`이 있으면 그대로 사용, 없으면 `**/*.ts(x)`).
분석은 두 패스로 이루어진다.

**Pass 1 — 데이터 흐름 전파 (`DataFlowAnalyzer.propagate`)**
API 응답 값이 어디로 흘러가는지 추적한다. 변수는 이름이 아니라 **TypeScript symbol**로 식별하므로
shadowing이나 다른 파일에서 import한 함수도 정확히 구분된다. 선언 순서에 영향받지 않도록 fixpoint까지 반복한다.

추적하는 값의 종류:

| kind | 의미 | 전이 |
|---|---|---|
| `envelope` | axios response, `useQuery`/`useSWR` 결과 | `.data` → body |
| `fetchResponse` | `fetch()` Response | `.json()` → body |
| `body` | 응답 body (또는 그 하위) | `.x` → path에 x 추가 |

지원하는 흐름:

- 변수 할당, `await`, 괄호/`!`/`as`, `??`/`||`/`&&`/삼항
- 구조분해 `const { name } = await getUser(id)` (구조분해 자체가 필드 접근으로 기록됨)
- **Wrapper 함수 자동 추론**: `getUser()`가 `axios.get(...)`의 `.data`를 반환하면, `getUser()` 호출도 같은 endpoint의 API 호출로 인식. `userApi = { getUser: ... }` 같은 client 객체, 클래스 메서드, 다른 파일에서 import한 함수 포함. `request(url)`처럼 URL을 인자로 받으면 호출부 인자로 endpoint를 결정.
- `.then(cb)`, `.then(setUser)`
- React: `useState` setter → state 변수, JSX props → 자식 컴포넌트 파라미터(구조분해/`props.x`), `useQuery({ queryFn })`
- 배열: `.map/.forEach/.filter/.find/...` 콜백 파라미터, `for...of`
- 프로젝트 내 함수에 인자로 넘기면 파라미터로 추적, 추적 불가한 함수를 거치면 `derived`

**Pass 2 — 기록**
각 파일에서 File/Function/API Call/Property Access를 수집한다. Property access는 멤버 체인의 가장 바깥
노드에서 한 번만 기록하고(`user.profile.email` → `["profile","email"]`), `user.name.toUpperCase()`처럼
메서드 호출인 마지막 segment는 제외한다.

**API Call 인식 (MVP)**
- `axios.get/post/put/delete/patch`, `axios.create()`로 만든 인스턴스(다른 모듈에서 import해도 인식)
- `fetch(url, { method })` (기본 GET)
- Wrapper 함수 (위 참조)
- `tacet.config.json`의 `apiClientMap` (추론이 불가능한 client용 명시적 매핑, 추론보다 우선)

URL은 정적으로 해석 가능한 경우만 패턴화한다: 문자열, 템플릿 리터럴(`` `/users/${id}` ``), 문자열 연결(`"/users/" + id`)은
`/users/{param}`이 되고, 완전히 동적인 URL은 `null`로 둔다(추측하지 않음).

## 5. Java API 분석 방법 (Phase 2, 구현됨)

`packages/extractor-java/jvm` — JavaParser 기반 독립 JAR. `java -jar tacet-java-extractor.jar <backendDir>` →
stdout에 `BackendManifest` JSON. Node 쪽 `@tacet-api/extractor-java`가 `SubprocessExtractor`로 실행한다.
JDK 17+에서 동작하며 CLI는 `tacet extract-backend <dir>`.

**이름 해석은 소스만으로 한다.** JavaSymbolSolver는 정확한 해석을 위해 Spring·Lombok 등 의존성 JAR 전체를 classpath로
요구하는데, 이는 CI에서 backend를 빌드해야 한다는 뜻이다. 대신 `SourceIndex`가 import / 같은 package /
nested type / wildcard import / static import 규칙으로 프로젝트 타입과 상수를 결정적으로 해석한다.
프로젝트 밖의 타입은 알려진 목록(String, List, Map, ResponseEntity, Page 등)으로 처리하고 나머지는 `unknown`으로 남긴다.

**Endpoint**
- `@RestController`, `@Controller`(+`@ResponseBody` 또는 `ResponseEntity` 반환), mapping이 있는 interface. `@FeignClient`/`@HttpExchange`(client)와 `src/test`는 제외.
- `@Get/Post/Put/Delete/PatchMapping`, `@RequestMapping(method=...)`(method 생략 시 5개 전부). 클래스 레벨 prefix × 메서드 path 조합.
- path의 상수 참조(`ApiPaths.USERS`, static import, `A + "/x"`)를 해석. 해석 불가 시 `<expr>` 그대로 두고 warning.
- `@PathVariable/@RequestParam/@RequestHeader`(name, required, defaultValue, Optional), `@RequestBody`(required).
  어노테이션 없는 단순 타입은 선택 query param, 객체는 필드별 query param(`@ModelAttribute` 동작). `Pageable`, `HttpServletRequest` 등 framework 파라미터는 제외.
- 반환 타입에서 `ResponseEntity/Optional/CompletableFuture/Mono/DeferredResult/...` 를 벗기고 `Flux<T>`는 배열, `void`/`Void`는 body 없음.

**DTO (Jackson 기준 JSON 형태)**
- endpoint에서 도달 가능한 타입만 수집. 상위 클래스 필드 flatten(제네릭 상위 타입은 타입 인자 치환), record component, public getter(`getX`/`isX`), interface projection.
- `@JsonProperty` 이름, `@JsonIgnore`, `@JsonIgnoreProperties`, `@JsonNaming`(snake/kebab/...), `static`/`transient` 제외.
- nullable: primitive → false, `@NotNull/@NonNull/@NotBlank/@NotEmpty` → false, `@Nullable`/`Optional` → true, 나머지 참조 타입 → true.
- Enum 값(`@JsonProperty` 반영), Spring Data `Page<T>`/`Slice<T>`는 실제 JSON 모양(`content`, `totalElements`...)의 DTO로 모델링.
- 알려진 한계: 전역 Jackson 설정(`spring.jackson.property-naming-strategy`), `@JsonUnwrapped`, `@JsonValue` enum(warning), Kotlin 소스.

## 6. API ↔ TypeScript 연결 방법 (Phase 3, 구현됨)

`core/src/analysis/link.ts` — `EndpointLinker`

- 양쪽 path를 같은 `normalizePath`로 정규화(`{id}`, `{id:\\d+}`, `:id`, 템플릿 변수 → `{param}`)하고 segment 단위로 비교.
- backend `{param}`은 frontend의 어떤 segment(`/users/42` 포함)와도 맞는다. frontend 동적 segment vs backend literal은 약한 일치로, `/users/${x}`는 `/users/search`보다 `/users/{id}`를 우선한다.
- 결과: `matched` · `method-mismatch`(path는 있으나 method가 다름, 가능한 method 목록 제공) · `not-found`(유사 endpoint 제안) · `unresolved`(URL을 정적으로 알 수 없음).
- `linking.frontendBasePath`(axios baseURL 등) / `linking.backendBasePath`(context-path) 설정으로 prefix 차이를 맞춘다.
- 링크는 저장하지 않고 조회 시 `ProjectModel`이 계산한다. frontend/backend 어느 쪽만 다시 추출해도 즉시 반영된다.

## 7. Index schema (SQLite)

`node:sqlite`(Node 22.13+ 내장)를 사용해 native 모듈 빌드 없이 CI에서 동작한다. index는 extractor manifest의
**캐시**다. 각 row는 IR 객체 JSON 전체 + 조회용 컬럼만 가진다(외래키 없음, schema version이 다르면 재생성).

```sql
index_meta(key, value)   -- schemaVersion, language, rootDir, generatedAt, config, backend.*
files(id, file, json)
functions(id, file, name, json)
api_calls(id, file, method, endpoint_pattern, json)
property_accesses(id, file, api_call_id, json)
endpoints(id, file, method, path, json)
dtos(id, file, name, json)
enums(id, file, name, json)
```

**Incremental 갱신**: `writeManifest`는 전체를 지우고 다시 쓰지 않는다. row JSON을 비교해 바뀐 row만
upsert/delete하고, 영향받은 **파일 목록**을 돌려준다. ID는 위치 기반(`call:<file>:<line>:<col>`)이라 바뀌지 않은
코드는 같은 row로 유지된다. 분석 자체는 cross-file 흐름(wrapper, JSX props) 때문에 프로젝트 전체를 대상으로 하되,
`TypeScriptProject.refresh(files)`로 바뀐 파일만 다시 읽는다(MCP 같은 상주 프로세스에서 AST 재사용).

## 8. API change detection (Phase 4, 구현됨)

`core/src/analysis/diff.ts` — `diffBackends(before, after)`

두 `BackendManifest`를 endpoint id(`METHOD path`)로 맞추고 타입을 재귀적으로 비교한다. 제네릭은 양쪽에서 각각
치환하고 순환 DTO는 방문 집합으로 멈춘다. 모든 변경은 frontend index와 같은 **body 기준 path**(`data.[].name`,
`"[]"` 배열 원소, `"*"` map 값)로 표현된다.

| 대상 | 변경 | breaking (frontend 관점) |
|---|---|---|
| endpoint | removed / moved(같은 handler의 path 변경) / added | removed, moved |
| parameter | added / removed / type / optional→required | 필수 추가, 필수화, JSON 타입 변경 |
| request body | added / removed, 필드 added(필수) / removed / nullable→non-null | 필수 필드 추가·필수화 (삭제는 Jackson 기본 설정상 무해) |
| response | 필드 removed / type / nullable / 배열↔객체 / enum 값 | 삭제, JSON 타입 변경, nullable화, shape 변경, enum 값 삭제 |

타입 비교는 JSON 수준 범주(number / string / boolean / object / array)로 breaking 여부를 판단한다.
`Integer → Long`은 변경으로 기록하되 breaking이 아니다.

## 9. Static impact analysis (Phase 5, 구현됨)

`core/src/analysis/change-impact.ts` — `analyzeChangeImpact(frontend, before, after)`

frontend 호출은 **before** 계약에 연결한다(코드가 작성된 기준). breaking 변경마다 해당 endpoint의 호출/필드 읽기를
path로 매칭해 등급을 매긴다.

| 변경 | DEFINITE | LIKELY | POSSIBLE |
|---|---|---|---|
| endpoint 삭제 | 모든 호출 | | |
| endpoint 이동 | URL을 직접 쓰는 호출 | | client 함수를 거치는 호출 |
| 필드 삭제 | 그 path(이하)를 읽음 | | 추적 불가 함수를 거쳐 읽음(`derived`) |
| 타입 변경 | | 그 path를 읽음 | derived |
| 배열↔객체 | 그 아래를 읽음 (`tags[0]`, `tags.length`) | 값 자체를 사용 | derived |
| nullable화 | | 그 아래를 읽음 (`profile.email`) | 값 자체를 사용 |
| enum 값 삭제 | | | 그 필드를 읽음 |
| 필수 param/body 필드 추가 | 보내지 않음이 확인됨 | | request key를 정적으로 알 수 없음 |

같은 위치에 여러 변경이 걸리면 한 항목으로 합치고(가장 높은 등급 + 모든 이유), endpoint와 전체 결과는
DEFINITE가 있으면 `FAIL`, LIKELY/POSSIBLE만 있으면 `WARNING`, 없으면 `PASS`. Text / JSON / Markdown(PR 코멘트용,
`core/src/report/markdown.ts`)으로 출력한다.

## 10. AI verification (Phase 6, 구현됨)

AI는 분석 엔진이 아니라 **검증 레이어**다. 정적 분석이 확정하지 못한 위치만 다시 보고, 근거 없는 판단은 받지 않는다.

```text
ChangeReport ──▶ verifyChangeReport (core, vendor 중립)
                  ├─ 대상: LIKELY / POSSIBLE site만 (DEFINITE는 전송·변경 안 함), endpoint당 최대 25개
                  ├─ 입력: 변경 목록 + 변경 전/후 응답 스키마(TS 형태) + 후보 위치 + 코드 snippet
                  │        (후보 ±6줄, 데이터를 가져온 API 호출 ±3줄, 파일별로 병합) — repository 전체 X
                  ├─ buildVerificationPrompt → AiProvider.verify → 구조화된 verdicts
                  └─ 검증: evidence(file, line, code)가 보낸 snippet의 해당 줄(±1)에 실제로 있어야 함
                           없으면 UNKNOWN으로 강등, 누락된 id도 UNKNOWN
```

`core/src/ai/`

| 파일 | 역할 |
|---|---|
| `types.ts` | `AiProvider { name, model, verify(request) }`, request/verdict 타입 |
| `prompt.ts` | 모든 provider가 그대로 보내는 system/user prompt |
| `schema-render.ts` | DTO를 frontend가 받는 JSON 모양(`{ age: number; profile: {...} \| null }`)으로 렌더링 |
| `verify.ts` | 후보 선택, snippet 수집, 동시 실행(기본 3), evidence 검증, 결과 병합 |

결과 판정 (endpoint 단위): DEFINITE 존재 → FAIL · AI FAIL → FAIL · 모든 후보 PASS → PASS · 그 외(WARNING, UNKNOWN,
호출 실패) → WARNING. `staticResult`를 함께 보존하므로 AI가 무엇을 바꿨는지 추적할 수 있다.

**Provider** — `packages/ai-anthropic` (`AnthropicProvider`)
- 공식 `@anthropic-ai/sdk`의 `client.beta.messages.parse` + `betaZodOutputFormat`(구조화된 출력)로 스키마에 맞는 verdict만 받는다.
- 기본 모델 `claude-opus-5`(`--model` / `TACET_AI_MODEL`), adaptive thinking, `--effort` 선택.
- 서버 측 refusal fallback(`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) 사용. `refusal` / `max_tokens` stop reason은 오류로 처리.
- 인증은 SDK 기본 해석 순서(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ant auth login` profile).
- 다른 provider(OpenAI, 로컬 LLM)는 `AiProvider`를 구현한 패키지를 추가하고 `createAiProvider`(`packages/cli/src/ai.ts`)에 등록한다. prompt와 검증 로직은 공유된다.

## 11. Frontend 변경 검사 · 영향 범위 탐색 (Phase 3, 구현됨)

**Contract check** (`core/src/analysis/contract.ts`, `tacet check`)

frontend의 API 사용을 실제 backend 계약과 대조한다. 범위를 파일로 제한하면 해당 파일의 호출 + 해당 파일이 읽는
응답(다른 파일에서 호출해 props로 넘어온 것 포함)을 검사하고, 호출이 그 파일에 있으면 다른 파일의 필드 읽기까지 검사한다.

| code | severity | 의미 |
|---|---|---|
| `ENDPOINT_NOT_FOUND` | error | backend에 해당 endpoint 없음 (유사 endpoint 제안) |
| `METHOD_MISMATCH` | error | path는 있지만 그 HTTP method는 없음 |
| `FIELD_NOT_FOUND` | error (derived면 warning) | 응답 타입에 없는 필드 읽기, 오타면 `Did you mean` |
| `NOT_AN_ARRAY` / `NOT_AN_OBJECT` | error | 객체를 배열처럼, enum/scalar를 객체처럼 사용 |
| `NO_RESPONSE_BODY` | error | body가 없는 endpoint의 응답을 읽음 |
| `UNKNOWN_BODY_FIELD` / `MISSING_BODY_FIELD` | warning | request DTO에 없는 key / 필수(non-null) 필드 누락 |
| `UNKNOWN_QUERY_PARAM` / `MISSING_QUERY_PARAM` | warning | 받지 않는 query param / 필수 param 누락 |
| `UNRESOLVED_ENDPOINT`, `UNVERIFIABLE_FIELD` | info | 정적으로 확정 불가 (추측하지 않음) |

응답 path 검사는 제네릭을 치환하며(`ApiResponse<Page<User>>`의 `data.content[].name`), 배열 원소(`[]`), map 값,
문자열/배열의 `length`를 이해한다. 결과: `PASS` / `WARNING` / `FAIL`, `--fail-on`으로 CI exit code 결정.

**Frontend 변경 흐름**

```bash
tacet index ./frontend --changed-since origin/main --check   # 갱신 → 사용 API 목록 → 계약 검사
tacet index ./frontend --files src/pages/User.tsx --check
```

**Impact explorer** (`core/src/analysis/impact.ts`, `tacet impact`) — 실제 변경 없이 영향 범위를 본다.

| 질의 | 결과 |
|---|---|
| `--api "GET /users/{id}"` | 호출 위치(client 함수 경유 포함), 읽는 필드별 위치, 파일·컴포넌트 수 |
| `--file src/api/user.ts` | 이 파일이 쓰는 API, 여기 정의된 client 함수와 그 호출처, import하는 파일(전이), blast radius |
| `--field UserResponse.name` | 이 필드를 반환하는 모든 endpoint 경로(`[].name`, `content[].name`, `data.name`)와 읽는 위치 |
| `--search <text>` | API·파일·함수·컴포넌트·DTO·필드 통합 검색 (각각 영향 API/파일 수) |
| `--summary` | API를 영향 파일 수로 정렬, 파일을 사용 API 수로 정렬, 아무도 안 쓰는 backend endpoint |

**Graph** (`core/src/analysis/graph.ts`, `core/src/report/`)

```text
endpoint ──calls──▶ api client fn ──calls──▶ caller fn/component ──defined-in──▶ file
endpoint ──has-field──▶ field ──reads──▶ reading fn/component ──defined-in──▶ file
```

각 노드에 영향 수(endpoint/field: 하위 파일 수, 함수/파일: 상위 API 수)를 계산한다. 출력:
- `--format html`: 외부 요청 없는 단일 HTML. 계층 레이아웃, 검색, 종류 필터, 노드 클릭 시 상·하류 추적과 상세 패널, 검색 가능한 목록, 라이트/다크.
- `--format mermaid`: PR 코멘트·문서용. `--format json`: 다른 도구용.

## 12. Library / MCP (구현됨)

```text
                 ┌───────────────────────── @tacet-api/mcp ─────────────────────────┐
 MCP client ───▶ │ tacet-mcp (stdio, 공식 SDK)   addTacetTools(fastmcp server) │
                 │            └──────── createTacetTools() ─────────┘           │
                 └──────────────────────────────┬─────────────────────────────────┘
 Python FastMCP ─▶ tacet (python) ─▶ CLI --format json ─┐
                                                          ▼
                                   TacetWorkspace (@tacet-api/cli) ─▶ @tacet-api/core + extractors
```

- **`createTacetTools(options)`**: 프레임워크 중립 tool 정의(zod schema + JSON 결과 handler, read-only annotation).
  나머지는 모두 이 정의를 등록만 한다.
- **`tacet-mcp`**: 공식 `@modelcontextprotocol/sdk` 기반 stdio 서버. `--index/--frontend/--backend/--config`
  (또는 `TACET_*` env)로 기본 경로를 주면 client는 경로를 몰라도 된다. 오류는 `isError` 결과로 반환.
- **`addTacetTools(fastmcpServer, { prefix })`**: TypeScript `fastmcp`의 `addTool`에 그대로 등록(실제 fastmcp
  타입으로 type-check, HTTP 통합 테스트).
- **Python `tacet`**: CLI의 JSON 출력을 감싸는 `Tacet` 클래스와 `tacet.fastmcp.register_tools(mcp)`.
  분석 로직은 Node 쪽 한 곳에만 있고 Python은 호출만 한다(동작이 갈라지지 않음).
- 상주 프로세스(MCP)에서는 workspace가 `TypeScriptProject`를 유지하므로 `index_frontend(files=...)`가 바뀐 파일만 다시 읽는다.
- impact 결과의 graph는 `graph: none | mermaid | json`으로 크기를 조절한다(LLM에는 mermaid가 간결).

## 13. CI/CD (Phase 7, 구현됨)

```text
git push / PR → CI
  tacet index <frontend>
  tacet diff --base <base> --backend <backend>          backend at base vs head (git archive, 작업 트리 불변)
      └─ backend 변경 없음 → 즉시 PASS (추출 생략)
  tacet extract-backend <backend>
  tacet check --changed-since <base>                    바뀐 frontend 파일 vs 새 계약
  → report.md (job summary + PR 코멘트) → exit 1 (fail-on 기준)
```

- `scripts/tacet-ci.sh`: 위 흐름 전체. 환경 변수만으로 설정하므로 어떤 CI에서도 사용 가능.
- `action.yml`: Node/Java 설정 → Tacet 빌드 → 스크립트 실행 → PR 코멘트 갱신(`gh pr comment --edit-last --create-if-none`).
- `--fail-on`: 변경 영향은 `definite|likely|possible|never`, 계약 검사는 `error|warning|never`.
- `TACET_AI_PROVIDER`(action: `ai-provider`)를 주면 `diff` 대신 `verify --base`를 실행한다. 자격 증명이 없거나 실패하면 정적 결과로 판정한다.
