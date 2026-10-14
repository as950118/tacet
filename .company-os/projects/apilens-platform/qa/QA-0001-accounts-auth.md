# QA Report: QA-0001 — 계정 테이블·자체 인증 (TASK-0002, TASK-0003)

| Field | Value |
|-------|-------|
| QA ID | QA-0001 |
| Tasks | [TASK-0002](../../../tasks/TASK-0002.md), [TASK-0003](../../../tasks/TASK-0003.md) |
| Build | `feature/platform-workspaces` @ `c4638fc` (commits `965b9df`, `bcb1365` 및 R1·R2 후속 커밋) |
| Review | [REVIEW-0001](../reviews/REVIEW-0001-accounts-auth.md) (Approved 2026-10-14) |
| QA | QA Agent (Claude) |
| Date | 2026-10-14 |
| 결정 | **Sign-off**: 대상 Task의 결함 0건. 범위 밖 관찰 5건은 아래에 기록했다. |

## 1. Scope

REVIEW-0001 Handoff에서 정한 범위다.

| 기준 | 내용 | 포함 여부 |
|------|------|-----------|
| PRD-0001 AC-1 (API 부분) | 이메일/비밀번호 가입·로그인·로그아웃, 세션 | 포함. 대시보드 쿠키는 TASK-0006 범위라 제외 |
| PRD-0001 AC-7 | 기존 `/projects/{name}` 경로와 `TACET_API_TOKEN`이 그대로 동작하고, SQLite에서 플래그가 없으면 아무것도 바뀌지 않음 | 포함 |
| TASK-0002 AC-1~4 | 마이그레이션 러너, 멱등성, advisory lock, `tacet platform migrate`, 인덱스 재생성 후 계정 보존 | 포함 |
| TASK-0003 AC-1~5 | scrypt, 비밀번호 10~256자, 세션 해시 저장·만료·폐기, 열거 방지, 스로틀, machine principal, 401 | 포함 |
| PRD-0001 AC-9 (테넌트 격리) | | 제외 (TASK-0009) |

## 2. Environment

- macOS (darwin 25.5), Node 26.7, vitest 5.0.1
- SQLite: scratchpad의 임시 `.db` 파일
- PostgreSQL: 로컬 컨테이너 `postgres://tacet:tacet@localhost:55432/tacet`, 테스트마다 별도 schema(`?schema=qa0001_*`)를 쓰고 끝난 뒤 DROP했다.
- 실제 서버: `npm run build` 후 `node packages/cli/dist/bin.js --index <db> serve --accounts --port 47811 --token mtok [--allow-dir test/fixtures] [--trust-proxy]`. 백그라운드로 띄우고 단계마다 종료했다. 블랙박스 스크립트는 Node `fetch`로 작성했다(커밋하지 않음).
- `NODE_OPTIONS=--max-old-space-size=4096`으로 띄웠다. 이 값이 없으면 CLI가 자식 프로세스로 재실행되어 래퍼 PID만 종료된다(관찰 O2). 배포(`render.yaml`)도 `NODE_OPTIONS`를 설정한다.
- 동시 작업: 같은 작업 트리에서 TASK-0004가 진행 중이었다. 첫 번째 전체 실행(225개)은 커밋된 상태에서 했다(REVIEW-0001의 225개와 같다). 이후 실행에는 TASK-0004 변경분(`/workspaces` 라우트 등)이 포함되었고, 그 상태에서도 범위 안의 결과는 같았다.

## 3. 자동 테스트 실행 결과

| 실행 | 결과 |
|------|------|
| `npm test` (SQLite), 커밋 상태 | 17 files, **225 passed** |
| `TACET_TEST_POSTGRES_URL=… npm test`, 커밋 상태 | 17 files, **253 passed** |
| QA 테스트 추가 후 `npm test` (SQLite, TASK-0004 진행분 포함) | 19 files, **247 passed** |
| QA 테스트 추가 후 PG 포함 | 19 files, **296 passed** |
| `server-accounts.test.ts` 단독 | SQLite 13 / PG 포함 26 passed |

### 추가한 테스트

`packages/cli/test/server-accounts.test.ts`에 `QA-0001 accounts over HTTP on $name` describe를 추가했다. 7개 케이스이고 SQLite·PG에서 각각 실행되므로 14개다. 프로덕션 코드는 바꾸지 않았다.

1. 비밀번호 경계 9/10/256/257 (가입), 로그인 256 → 200, 257 → 401
2. 깨진 JSON, 배열·문자열·빈 바디, 타입이 틀린 필드 → 400
3. 이메일 대소문자·공백 무시(중복 409, 로그인 성공), 잘못된 비밀번호와 없는 이메일의 오류가 같은 401
4. 로그아웃은 그 세션만 끝낸다. 두 번째 로그아웃·machine 토큰 로그아웃 → 401, `WWW-Authenticate: Bearer`
5. 서버를 재시작해도 사용자·세션이 유지된다
6. AC-7: 사용자 세션은 `/projects/{name}` 읽기·쓰기에서 401이고, machine 토큰은 인덱싱 후 `/pages` 200
7. `X-Forwarded-For`는 `trustProxy`일 때만 쓰인다. 위조 헤더로 IP 스로틀을 우회할 수 없고, 프록시 뒤에서도 이메일 키 스로틀은 유지된다

## 4. Test Matrix (블랙박스, 실제 서버)

S = SQLite, P = PostgreSQL. 모두 Pass다.

| # | 기준 | 시나리오 | 기대 | 결과 S | 결과 P |
|---|------|----------|------|--------|--------|
| 1 | AC-1 | signup → `/me` → login(새 토큰) → logout → `/me` | 200 → 200 → 200 → 200 → 401 + `WWW-Authenticate: Bearer` | Pass | Pass |
| 2 | AC-1 | 가입 응답에 비밀번호 해시 없음, 이메일 정규화(`  QA.User@Example.COM ` → `qa.user@example.com`), displayName trim | 정규화됨, `scrypt` 문자열 없음 | Pass | Pass |
| 3 | AC-1 | 세션 만료 시각 | 약 30일 뒤 | Pass | Pass |
| 4 | T3 AC-5 | `/me`에 토큰 없음, `garbage`, 빈 `Bearer `, machine 토큰 | 401 | Pass | Pass |
| 5 | T3 AC-2 | 한 세션 로그아웃 후 다른 세션 | 다른 세션 200, 로그아웃한 세션 재로그아웃 401 | Pass | Pass |
| 6 | AC-1 | 중복 이메일 `qa.user@…`, `QA.USER@…`, 앞뒤 공백 | 409 | Pass | Pass |
| 7 | T3 AC-1 | 비밀번호 9 / 10 / 256 / 257자 | 400 / 200 / 200 / 400 | Pass | Pass |
| 8 | T3 AC-1 | 로그인 256자 / 257자 | 200 / 401 | Pass | Pass |
| 9 | T3 AC-1 | 한글 10자 비밀번호 가입·로그인 | 200 | Pass | Pass |
| 10 | 입력 검증 | 깨진 JSON, `[]`, `"x"`, 빈 바디, 필드 누락, `null`, 숫자 email, 배열·객체 password, 숫자 displayName, 잘못된 이메일, 255자 이메일 | 400 | Pass | Pass |
| 11 | 입력 검증 | 5MB 바디 | 413 | Pass | – |
| 12 | T3 AC-3 | 잘못된 비밀번호 vs 없는 이메일 | 같은 401 + 같은 메시지 | Pass | Pass |
| 13 | T3 AC-3 | 응답 시간 비교(중앙값) | 비슷함 (147.4ms vs 146.0ms) | Pass | – |
| 14 | T3 AC-3 | 같은 이메일로 10회 실패 → 11번째 | 10번째 401, 11번째 429 + `Retry-After` 899 (≤ 900) | Pass | Pass |
| 15 | T3 AC-3 | 같은 IP에서 다른 계정을 올바른 비밀번호로 | 429 (IP 키) | Pass | Pass |
| 16 | T3 AC-3 | 프록시 없이 `X-Forwarded-For`를 바꿔 10개 이메일 실패 → 다른 계정 | 429 (위조 헤더 무시) | Pass | – |
| 17 | T3 AC-3 | `--trust-proxy`: 서로 다른 IP 10개로 한 이메일 실패 → 새 IP | 429 (이메일 키), 다른 계정·다른 IP는 200 | Pass | – |
| 18 | T3 AC-3 | `--trust-proxy`: 한 IP에서 10개 이메일 실패 → 같은 IP, 첫 값 기준 `10.9.9.9, 1.1.1.1` | 429 | Pass | – |
| 19 | AC-7 / T3 AC-4 | 사용자 세션으로 `GET /projects` | 401 | Pass | Pass |
| 20 | AC-7 / T3 AC-4 | machine 토큰으로 `GET /projects`, 익명은 401 | 200 / 401 | Pass | Pass |
| 21 | AC-7 | `TACET_API_TOKEN=envtok TACET_ACCOUNTS=true`(환경변수)로 기동, `/projects`, `/projects/x/pages` | envtok 200, 다른 토큰 401, health `accounts:true` | Pass | – |
| 22 | – | `/health` | `accounts: true` (플래그 없으면 `false`) | Pass | Pass |
| 23 | – | `/openapi.json` | `/auth/signup`, `/auth/login`, `/auth/logout`, `/me` 포함. login은 `security: []`, `/me`는 bearer 필요 | Pass | Pass |
| 24 | AC-1 | 서버 재시작 후 이전 세션 `/me`, 로그인, 중복 가입 | 200 / 200 / 409 | Pass | Pass |
| 25 | T2 AC-2,3 | `tacet platform migrate` 2회 (새 DB) | 1회차 "Applied … 1", 2회차 "up to date (1)", exit 0, `platform_migrations` 1행 | Pass | Pass |
| 26 | T2 AC-2,3 | 데이터가 있는 DB에 migrate | "up to date", 사용자 유지 | Pass | – |
| 27 | T2 AC-2 | 이미 있는 schema에 `platform migrate` 5개 동시 실행 | 1개만 적용, 4개 up to date, 1행 (advisory lock) | – | Pass |
| 28 | AC-7 | `--accounts` 없이 기동 (계정 테이블이 있는 DB, 새 DB 각각) | `/auth/login`·`/auth/signup`·`/me` 404, OpenAPI에 auth 경로 없음, health `accounts:false` | Pass | – |
| 29 | AC-7 | `--accounts` 없이 새 SQLite DB | 계정 테이블이 생기지 않음(인덱스 테이블만) | Pass | – |
| 30 | AC-7 | 레거시: `--allow-dir test/fixtures`, machine 토큰으로 `POST /projects/x/frontend` → `GET /projects/x/pages` | 200 (9 files, 14 apiCalls) / 200 + 페이지 목록, 익명 401 | Pass (플래그 유/무) | Pass |
| 31 | AC-7 | 레거시 경로에 사용자 세션으로 읽기·쓰기 | 401 | Pass | – |
| 32 | 호환 | `--accounts`인데 토큰 없음(loopback) | `/projects` 익명 200(기존 동작), 가입·`/me` 200, `/me` 익명 401 | Pass | – |
| 33 | 호환 | `--host 0.0.0.0`인데 토큰 없음 | 기동 거부 | Pass | – |
| 34 | T2 AC-4 | 인덱스 재생성 후 계정 보존 | `platform-migrations.test.ts` "keeps accounts when the index is rebuilt" | Pass | Pass |
| 35 | T3 AC-2,5 | 만료·슬라이딩 연장·만료 세션 정리 | `platform-accounts.test.ts` (시계 주입) | Pass | Pass |

T2 = TASK-0002, T3 = TASK-0003.

## 5. Bugs

**대상 Task(TASK-0002/0003)의 결함: 0건.**

## 6. 범위 밖 관찰 (Bug 아님, 참고)

| # | 심각도 | 내용 | 재현 | 제안 |
|---|--------|------|------|------|
| O1 | Low | 아직 없는 PG schema에 여러 프로세스가 동시에 처음 접속하면 `CREATE SCHEMA IF NOT EXISTS`가 경합해서 일부가 `duplicate key value violates unique constraint "pg_namespace_nspname_index"`로 실패한다. 플랫폼 마이그레이션 lock 이전 단계인 인덱스 드라이버(`driver.ts:171`, `6dbb50e`)의 기존 동작이다. schema가 있으면 lock이 정상 동작한다(#27). | `for i in 1 2 3; do node packages/cli/dist/bin.js --index "postgres://…/tacet?schema=new_x" platform migrate & done; wait` → 3개 중 2개 실패 | Backend: schema 생성도 lock 안에서 하거나 실패 시 한 번 재시도. 첫 배포 때 인스턴스 1개라면 영향 없음 |
| O2 | Low | `bin.js`는 힙을 키우려고 `spawnSync`로 자식 프로세스를 띄운다. 래퍼 PID에 SIGTERM을 보내면 자식 서버가 계속 포트를 잡고 있다. 기존 동작이고, `render.yaml`은 `NODE_OPTIONS`를 설정하므로 재실행되지 않는다. | `NODE_OPTIONS` 없이 `serve &` → `kill $!` → 포트가 계속 LISTEN | DevOps: 컨테이너나 서비스 매니저에서 `NODE_OPTIONS`를 꼭 설정하도록 문서화 |
| O3 | Info | 이메일 키 스로틀 때문에, 공격자가 틀린 비밀번호를 10번 보내면 정상 사용자도 15분 동안 로그인할 수 없다(429). ADR-0002 설계의 trade-off다. | #14 이후 올바른 비밀번호 → 429 | PM/Architect: TASK-0010(비밀번호 재설정) 때 함께 검토 |
| O4 | Info | 가입은 레이트 리밋이 없다. 409로 이메일 존재 여부가 드러나는 것은 기록된 trade-off(TASK-0010)다. | 가입을 반복 요청 | TASK-0010에서 함께 검토 |
| O5 | Info | `Authorization` 스킴은 대소문자를 구분한다(`bearer x`는 익명 처리). machine 토큰도 같은 기존 동작이다. | `curl -H "Authorization: bearer <token>" /me` → 401 | 필요하면 이후 정리 |

## 7. Decision

**Sign-off.** 범위(PRD-0001 AC-1 API 부분, AC-7, TASK-0002 AC-1~4, TASK-0003 AC-1~5)의 모든 항목에 증거가 있고 결함은 0건이다. TASK-0002와 TASK-0003을 Done으로 바꾸고 DevOps에 넘긴다. O1·O2는 TASK-0008(배포) 때 DevOps가 참고한다.

## Handoff

| From | To | Artifact |
|------|-----|----------|
| QA | DevOps | 이 리포트(QA-0001). 배포 시 참고: O1(동시 첫 기동), O2(`NODE_OPTIONS`), REVIEW-0001 R3(TASK-0008) |
