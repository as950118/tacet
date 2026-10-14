# QA Report: QA-0002 — 워크스페이스·멤버·초대 API (TASK-0004)

| Field | Value |
|-------|-------|
| QA ID | QA-0002 |
| Tasks | [TASK-0004](../../../tasks/TASK-0004.md) |
| Build | `feature/platform-workspaces` @ `58da07c` (commits `d6687e9`, `58da07c`) |
| Review | [REVIEW-0002](../reviews/REVIEW-0002-workspaces.md) (Approved 2026-10-14, Follow-up Resolution 반영) |
| Contract | [API-0001](../api/API-0001-workspaces.md) v0.2.0 |
| QA | QA Agent (Claude) |
| Date | 2026-10-14 |
| 결정 | **Sign-off**: 대상 Task의 결함 0건. 참고 관찰 5건은 아래에 기록했다. |

## 1. Scope

REVIEW-0002 Handoff에서 정한 범위다.

| 기준 | 내용 | 포함 여부 |
|------|------|-----------|
| PRD-0001 AC-2 | 가입 시(같은 트랜잭션) 개인 워크스페이스 생성, owner. 0개인 사용자는 직접 생성, `/me`가 개수를 알려 줌, GET에서 자동 생성하지 않음 | 포함 |
| PRD-0001 AC-3 | owner/admin의 초대·역할 변경·제거, 마지막 owner 보호 | 포함 |
| TASK-0004 AC-1~4 | AC-2·AC-3, 마지막 owner, 초대 토큰 해시·만료, OpenAPI 반영 | 포함 |
| API-0001 v0.2.0 | 14개 라우트 전체, 역할 매트릭스, 비멤버 404, 초대 수명주기, slug 별칭 308, slug 형식 | 포함 |
| REVIEW-0002 Operator 결정 | OQ-1(admin은 admin 이상을 다루지 못함, 유지), OQ-2, OQ-4, OQ-5 | 포함 |
| PRD-0001 AC-7 회귀 | QA-0001 흐름(가입·로그인·로그아웃, machine 토큰의 레거시 `/projects`) | 포함 |
| PRD-0001 AC-4~6, AC-9 | 워크스페이스 프로젝트, 분석 API 권한, 테넌트 격리 전체 | 제외 (TASK-0005, TASK-0009) |
| REVIEW-0002 R6, N3 | 매처 Fail Loud, 이벤트 로그 | 제외 (TASK-0005, TASK-0008로 이관) |

## 2. Environment

- macOS (darwin 25.5), Node 26.7, vitest 5.0.1
- SQLite: scratchpad의 임시 `.db` 파일
- PostgreSQL: 로컬 컨테이너 `postgres://tacet:tacet@localhost:55432/tacet`. 블랙박스는 새 schema(`?schema=qa0002_<epoch>_main`, `…_mig1`)를 쓰고 끝난 뒤 DROP했다. 남은 schema가 없음을 `pg_namespace`로 확인했다.
- 실제 서버: `npm run build` 후 `NODE_OPTIONS=--max-old-space-size=1024 node packages/cli/dist/bin.js --index <db> serve --accounts --token mtok --port 4782x [--allow-dir test/fixtures] [--cors https://dash.example]`. 스크립트가 백그라운드로 띄우고 단계마다 종료했다(QA-0001 O2 때문에 `NODE_OPTIONS`를 줬다). 기존 4318 서버는 건드리지 않았다.
- 블랙박스 스크립트는 Node `fetch`로 작성했다(scratchpad, 커밋하지 않음). DB 조작(초대 만료, 역할 직접 변경, 마이그레이션 1 상태 만들기)은 빌드된 `@tacet-api/core`의 `openSqlDriver`, `migratePlatform`, `PlatformAccounts`로 했다.
- 같은 작업 트리에 `web/` 변경(다른 작업)이 있었으나 테스트 대상과 무관하고 건드리지 않았다.

## 3. 자동 테스트 실행 결과

| 실행 | 결과 |
|------|------|
| `npm test` (SQLite), QA 시작 시 `58da07c` | 19 files, **264 passed** (REVIEW-0002 검증 수치와 같음) |
| `TACET_TEST_POSTGRES_URL=… npm test`, `58da07c` | 19 files, **330 passed** |
| QA 테스트 추가 후 `npm test` | 20 files, **271 passed** |
| QA 테스트 추가 후 PG 포함 | 20 files, **344 passed** |
| `server-workspaces-qa.test.ts` 단독 | SQLite 7 / PG 포함 14 passed |

### 추가한 테스트

새 파일 `packages/cli/test/server-workspaces-qa.test.ts`. 7개 케이스이고 SQLite·PG에서 각각 실행되므로 14개다. 기존 테스트 파일과 프로덕션 코드는 바꾸지 않았다. 기존 테스트가 core 단위로만 다루거나 HTTP에서 다루지 않던 부분이다.

1. admin 순위 규칙(OQ-1) HTTP: member↔viewer 200, admin·owner 부여 403, 다른 admin·owner·자기 자신 변경 403, admin·owner 제거 403, owner·admin 초대 403, 이전·삭제 403
2. 두 owner가 동시에 서로 강등·탈퇴·제거 → 한쪽 200, 다른 쪽 403/404/409, owner는 정확히 한 명
3. 만료 초대 410(DB로 `expires_at` 조작) → 재시작하면 정리되어 404, 대기 초대·멤버·별칭 308은 재시작 후에도 유지
4. 별칭(OQ-5): 다른 워크스페이스는 현재 slug·별칭으로 PATCH·POST 모두 409, 자동 slug와 개인 워크스페이스 slug는 별칭을 피해 접미사, C→A로 되돌리면 B·C가 A로 308, 비멤버 404
5. slug 경합(R4): 같은 지정 slug 동시 5건 → 200 1 + 409 4, 자동 slug 동시 5건 → 모두 200·서로 다름, 같은 slug로 동시 rename → 200/409, 로컬 파트가 같은 동시 가입 4건 → 모두 200, slug 경계값
6. `--cors`에서 `PATCH` preflight 204와 허용 헤더, 실제 PATCH 응답의 `Access-Control-Allow-Origin`
7. 마이그레이션 1 상태의 DB(워크스페이스 이전 사용자 포함)로 서버를 띄우면 2로 올라가고 기존 행이 유지됨, 0개 사용자의 생성

## 4. Test Matrix (블랙박스, 실제 서버)

S = SQLite, P = PostgreSQL. 블랙박스 스크립트 검사 302개가 양쪽 모두 통과했다(S 302/302, P 302/302). 아래는 시나리오 단위로 묶은 것이다.

| # | 기준 | 시나리오 | 기대 | 결과 S | 결과 P |
|---|------|----------|------|--------|--------|
| 1 | AC-2 | 가입 → `/me`, `GET /workspaces`, 멤버 목록 | `workspaces: 1`, 로컬 파트 slug, 본인 owner 1명 | Pass | Pass |
| 2 | AC-2 | 같은 로컬 파트로 다른 도메인 가입, 1글자 로컬 파트 | `<local>-xxxx`, 유효한 slug(`a-ws`) | Pass | Pass |
| 3 | AC-2 / OQ-2 | 개인 워크스페이스 DELETE → `/me`, `GET /workspaces` 여러 번 → `POST /workspaces` | 0, `[]`, GET 후에도 0(자동 생성 없음), 생성 200 owner, 다시 1 | Pass | Pass |
| 4 | AC-3 | 역할별(owner/admin/member/viewer) 워크스페이스·멤버 조회 | 모두 200, `role`이 자기 역할 | Pass | Pass |
| 5 | AC-3 | 역할별 초대 조회 | owner·admin 200, member·viewer 403. 목록에 `token` 없음 | Pass | Pass |
| 6 | AC-3 | 역할별 × 초대 역할 4종 | owner 전부 200, admin은 member·viewer만 200(owner·admin 403), member·viewer 전부 403 | Pass | Pass |
| 7 | AC-3 / OQ-1 | admin 역할 변경: member↔viewer / member→admin, →owner / 다른 admin, owner, 자기 자신 | 200 / 403 / 403 | Pass | Pass |
| 8 | AC-3 | member·viewer의 역할 변경(자기 자신 포함), 잘못된 역할 값, 없는 멤버 UUID, UUID 아닌 경로 | 403, 400, 404, 400 | Pass | Pass |
| 9 | AC-3 | 제거: member·viewer가 제거 / admin이 admin·owner 제거 / admin이 viewer·member 제거 | 403 / 403 / 200, 제거된 사람은 404 | Pass | Pass |
| 10 | AC-3 | 탈퇴: viewer `leave`, member `DELETE members/{me}`, admin `leave` | 200, 이후 404 | Pass | Pass |
| 11 | AC-3 | 이름 변경 / 이전 / 삭제를 owner 외 역할로 | 이름은 admin 200·member·viewer 403, 이전·삭제는 403 | Pass | Pass |
| 12 | AC-3 / N2 | 이전: 자기 자신 / 비멤버 / `userId` 없음 / 정상 / 이미 owner인 대상 | 400 / 404 / 400 / 200(대상 owner, 호출자 admin) / 200(대상 그대로, 호출자 admin). 이전 후 전 owner의 삭제 403 | Pass | Pass |
| 13 | T4 AC-2 | 유일 owner의 자기 강등, `DELETE members/{me}`, `leave` | 409 ×3 | Pass | Pass |
| 14 | T4 AC-2 | admin이 유일 owner 제거 | 403 (순위 검사가 먼저) | Pass | Pass |
| 15 | T4 AC-2 | owner 2명 중 한 명이 다른 owner 제거 → 남은 owner의 탈퇴·강등 | 200 → 409 ×2 | Pass | Pass |
| 16 | T4 AC-2 | 두 owner 동시 실행 8라운드: 서로 강등, 동시 탈퇴, 서로 제거, 강등+탈퇴 | 매 라운드 owner 정확히 1명(DB 확인). 패자 상태는 아래 관찰 O1 | Pass | Pass |
| 17 | AC-5(준비) / 존재 비노출 | 비멤버가 11개 `{ws}` 라우트(GET/PATCH/DELETE ws, members GET/PATCH/DELETE, leave, transfer, invites GET/POST/DELETE) | 모두 404, 없는 slug와 같은 상태·메시지 형태 | Pass | Pass |
| 18 | 인증 | 같은 11개 라우트 익명, machine 토큰으로 `GET /workspaces`·`/invites/accept` | 401 | Pass | Pass |
| 19 | IDOR (R5) | A의 owner가 `A/members/{B의 멤버}` PATCH·DELETE, `A/members/{B의 owner}` DELETE, B의 멤버에게 transfer, `A/invites/{B의 초대}` DELETE | 모두 404, B의 초대·멤버 그대로 | Pass | Pass |
| 20 | 경로 (R5) | `%zz`, `a%2Fb`, `PUT /workspaces` | 400, 400, 405 | Pass | Pass |
| 21 | T4 AC-3 | 초대 생성 | 토큰 43자 base64url(32바이트), 만료 168시간, DB에는 sha256만(원문 없음) | Pass | Pass |
| 22 | 초대 | 수락(초대 이메일과 다른 계정) → 같은 사용자 재수락 → 다른 사용자 수락 | 200 → 409 → 409. `accepted_by` 기록, 목록에서 빠짐 | Pass | Pass |
| 23 | 초대 | 토큰 누락 / 엉터리 토큰 / 익명 / 잘못된 이메일 / 잘못된 역할 / 이미 멤버인 이메일(대문자) | 400 / 404 / 401 / 400 / 400 / 409 | Pass | Pass |
| 24 | T4 AC-3 | `expires_at`을 과거로 바꾼 초대 | 목록에는 보임, 수락 410, 멤버 추가 안 됨 | Pass | Pass |
| 25 | 초대 | 취소 → 수락 / 다시 취소 | 404 / 404 | Pass | Pass |
| 26 | 초대 | 같은 이메일 재초대 | 이전 토큰 404, 대기 초대 1개 | Pass | Pass |
| 27 | 초대 | admin이 viewer 초대 수락 / member가 admin 초대 수락 | admin 유지(낮추지 않음) / admin으로 올라감 | Pass | Pass |
| 28 | R2 | admin이 owner·admin 초대 취소, owner 초대와 같은 이메일로 재초대 / owner가 만든 member 초대 취소 | 403, 403, 403(owner 초대 유지) / 200 | Pass | Pass |
| 29 | R1 | admin이 member 초대 생성 → owner가 admin 제거 → 그 토큰을 본인·다른 사람이 수락 | 초대 목록에서 사라짐, 404, 404, 본인은 여전히 비멤버 | Pass | Pass |
| 30 | R1 | admin → member 강등 후 그 admin의 초대 / admin이 탈퇴한 뒤 그 초대 | 404 / 404 | Pass | Pass |
| 31 | R1 | owner가 admin·member 초대를 만들고 소유권 이전(본인은 admin) | admin 초대 404, member 초대 200 | Pass | Pass |
| 32 | R1(b) | 초대한 admin의 역할을 DB에서 직접 viewer로(정리 로직 우회) → 수락 | 404 (수락 시 재검사) | Pass | Pass |
| 33 | R3 | 같은 토큰을 6명이 동시에 수락 | 200 1개 + 409 5개, 멤버 +1 | Pass | Pass |
| 34 | R3 | 수락과 취소를 동시에 | 한쪽만 성공하고 멤버십과 일치(관측: 수락 200·취소 404·멤버 있음) | Pass | Pass |
| 35 | OQ-5 | A→B→C 후 `GET /workspaces/A/members?x=1` | 308, `Location: /workspaces/C/members?x=1`. B도 C로(쿼리 2개 유지), `A/`(끝 슬래시) → `/workspaces/C` | Pass | Pass |
| 36 | OQ-5 | 별칭으로 DELETE / 별칭으로 PATCH를 리다이렉트 따라가며 | 308이고 삭제 안 됨 / 200, 이름 변경됨(메서드·body 유지) | Pass | Pass |
| 37 | OQ-5 | 비멤버가 A·B로 GET, 하위 경로, `leave` | 404, `Location` 없음 | Pass | Pass |
| 38 | OQ-5 | 다른 사용자가 A·B로 `POST /workspaces`, 다른 워크스페이스가 A·C로 PATCH | 409 | Pass | Pass |
| 39 | OQ-5 | 별칭과 같은 이름으로 slug 없이 생성 | 200, 접미사 slug (409 아님) | Pass | Pass |
| 40 | OQ-5 | C→A로 되돌림 | 200, 별칭 테이블은 B·C, C와 B가 A로 308, 같은 slug PATCH 200 | Pass | Pass |
| 41 | OQ-5 | 워크스페이스 삭제 | 별칭·멤버·초대 행 0(cascade), A·B·C 모두 다른 사용자가 생성 200, 전 멤버가 B로 요청하면 404 | Pass | Pass |
| 42 | slug 형식 | 2자 / 3자 / 40자 / 41자 / 대문자 / `_` / 앞·뒤 하이픈 / 안쪽 `--` / 숫자만 / 한글 / 공백 / `.` / 빈 값 / 숫자 타입 | 400 / 200 / 200 / 400 / 400 / 400 / 400 / 200 / 200 / 400 / 400 / 400 / 400 / 400 | Pass | Pass |
| 43 | name 형식 | 빈 값, 공백만, 100자, 101자, 누락, 숫자 / PATCH의 잘못된 slug·빈 name | 400, 400, 200, 400, 400, 400 / 400 | Pass | Pass |
| 44 | slug 형식 | 경로 slug 2자, 대문자 | 400 (핸들러 전) | Pass | Pass |
| 45 | R4 | 지정 slug 중복 POST, 다른 워크스페이스의 현재 slug로 PATCH | 409 | Pass | Pass |
| 46 | R4 | 같은 지정 slug 동시 POST 6건 / 같은 이름(자동 slug) 동시 6건 | 200 1 + 409 5 / 6건 모두 200·slug 6개 | Pass | Pass |
| 47 | R4 | 두 워크스페이스를 같은 slug로 동시 rename / rename과 create가 같은 slug로 동시에 | 200 + 409 / 200 + 409 | Pass | Pass |
| 48 | R4 | 로컬 파트가 같은 가입 5건 동시 | 모두 200, 개인 slug 5개 모두 다름 (500 없음) | Pass | Pass |
| 49 | T4 AC-4 | `/openapi.json` | 13개 `/workspaces…` 오퍼레이션 + `POST /invites/accept` + `GET /me` 모두 있음, member PATCH의 path parameter `ws`·`userId`, body에 role enum | Pass | Pass |
| 50 | CORS | `--cors https://dash.example`에서 `OPTIONS`(`Access-Control-Request-Method: PATCH`) → 실제 `PATCH` | 204, Allow-Origin·Allow-Methods에 PATCH·Allow-Headers에 authorization / 200, 응답에 Allow-Origin | Pass | Pass |
| 51 | 회귀 QA-0001 | 가입(이메일 정규화, displayName trim, 해시 없음), 중복 409, 9자 비밀번호 400, 로그인 200, 틀린 비밀번호 401, 로그아웃 → `/me` 401 + `WWW-Authenticate: Bearer`, 다른 세션 유지 | 기대대로 | Pass | Pass |
| 52 | 회귀 AC-7 | `GET /projects` machine 200·세션 401·익명 401, machine으로 `POST /projects/x/frontend` → `GET …/pages` 200, 세션으로 pages 401, health `accounts: true` | 기대대로 | Pass | Pass |
| 53 | 재시작 | 서버 종료 후 재기동: 세션, `/me`, 멤버, 별칭 308, 대기 초대 수락 | 모두 유지, 수락 200 | Pass | Pass |
| 54 | OQ-4 | 만료 초대를 만든 뒤 재기동 | 시작 시 정리되어 목록에서 사라짐, 대기 초대는 유지, 수락된 초대는 이력으로 남음 | Pass | Pass |
| 55 | 마이그레이션 | `migratePlatform(db, [migration 1])`로 만든 DB(사용자, 손으로 넣은 워크스페이스, 워크스페이스 없는 사용자)로 서버 기동 | `platform_migrations` = `[1 accounts-and-workspaces, 2 workspace-slug-aliases]`, 기존 로그인·워크스페이스 유지, 별칭·308 동작, 0개 사용자 `/me` 0 → 생성 200 | Pass | Pass |

T4 = TASK-0004.

## 5. Bugs

**대상 Task(TASK-0004)의 결함: 0건.**

## 6. REVIEW-0002 "Resolved" 항목 검증

| # | Resolution 주장 | QA 검증 | 결과 |
|---|-----------------|---------|------|
| R1 | 제거·탈퇴·강등·이전 시 부여할 수 없는 대기 초대 삭제 + 수락 시 `invited_by` 현재 역할로 재검사(404) | #29~#32. 리뷰 재현 시나리오(제거된 admin의 초대로 재가입)는 404이고 본인은 비멤버로 남는다. 강등·탈퇴·이전 각각과, 정리 로직을 DB로 우회한 경우(b)까지 404. 이전 후 member 초대처럼 아직 부여할 수 있는 초대는 살아 있음 | Resolved 확인 |
| R2 | 취소·같은 이메일 재초대에 `mayGrant` | #28. admin은 owner·admin 초대를 취소·대체할 수 없고(403) 그 초대는 남는다. 부여할 수 있는 역할(member)은 취소 200 | Resolved 확인 |
| R3 | 수락을 워크스페이스 잠금 안에서 직렬화 | #33(6명 동시 수락 → 200 1개), #34(수락·취소 동시 → 결과와 멤버십 일치). 양 방언 | Resolved 확인 |
| R4 | slug 경합 재시도·409, 가입 재시도 | #45~#48. 양 방언에서 500 없음. 자동 slug는 모두 성공, 지정 slug는 409 | Resolved 확인 |
| R5 | IDOR, 405, 깨진 인코딩, `%2F`, 동시 수락 테스트 | 기존 테스트 실행 통과 + 블랙박스 #19, #20, #33 | Resolved 확인 |
| N1 | PRD AC-2 문구를 "가입 시"로 | PRD-0001 AC-2 문구 확인. 동작은 #1·#3과 일치 | Resolved 확인 |
| N2 | 자기 자신에게 이전 400, 이미 owner인 대상 문서화 | #12. API-0001 `POST …/transfer`에 기술됨 | Resolved 확인 |
| OQ-2 | `/me.workspaces`, 0개 사용자 생성, GET에서 자동 생성 없음 | #3, #55(워크스페이스 이전에 가입한 사용자) | Resolved 확인 |
| OQ-4 | 만료 초대를 시작 시·매시간 정리, 수락 이력은 유지 | #54(시작 시 정리 관측). 매시간 타이머는 같은 함수를 `setInterval`로 호출하는 것을 코드로 확인(`server.ts:171-176`), 시간 경과는 관측하지 않았다 | Resolved 확인 |
| OQ-5 | 마이그레이션 2 별칭, 308(멤버만), 다른 워크스페이스가 못 가져감, 되돌리기, 삭제 시 해제 | #35~#41, #53(재시작 후에도), #55(1→2 업그레이드 DB에서도) | Resolved 확인 |
| R6, N3 | Open → TASK-0005, TASK-0008 | 범위 밖. 이관 상태 그대로 | – |

## 7. 관찰 (Bug 아님, 참고)

| # | 심각도 | 내용 | 재현 | 제안 |
|---|--------|------|------|------|
| O1 | Info | 두 owner의 동시 강등·제거에서 진 쪽은 409가 아니라 403(이미 admin으로 강등되어 owner를 바꿀 수 없음) 또는 404(이미 제거됨)를 받는다. 잠금 안에서 호출자 역할을 다시 읽기 때문이고, API-0001이 약속한 "owner는 한 명 남는다"는 지켜진다. 동시 탈퇴만 409다. | 두 owner가 `PATCH …/members/{상대}` `{role:"admin"}`를 동시에 → `[200, 403]` | 대시보드(TASK-0007)는 이 경우 403/404도 "상태가 바뀌었으니 새로고침"으로 다루면 된다 |
| O2 | Info | 별칭 경로에 대한 308은 역할 검사보다 먼저 나온다. viewer가 `PATCH /workspaces/{별칭}`을 보내면 308을 받고, 따라가면 403이다. 멤버에게만 주므로 노출은 없다. | viewer로 `PATCH /workspaces/<예전 slug>` → 308 | 없음 (문서화된 "멤버십 먼저" 순서와 일치) |
| O3 | Info | admin은 자기 역할을 낮출 수 없다(`PATCH members/{me}` `{role:"member"}` → 403). 순위 규칙(자기보다 낮은 역할만)의 결과이고 탈퇴는 가능하다. | admin으로 자기 자신 PATCH | PM: 필요하면 "자기 강등 허용"을 나중에 검토. API-0001 매트릭스에 한 줄 적어 두면 FE가 헷갈리지 않는다 |
| O4 | Info | 만료된 초대는 정리 전까지 `GET …/invites`에 `expiresAt`과 함께 남는다(API-0001에 기술). 대시보드가 만료 여부를 직접 표시해야 한다. | #24 | TASK-0007에서 반영 |
| O5 | Info | TASK-0004 노트의 "PG에서 rename과 create가 정확히 동시에 커밋되면 같은 문자열이 별칭이자 다른 쪽의 slug가 될 수 있다"는 경합은 재현되지 않았다(#47 rename·create 동시는 200/409). 현재 slug가 이기도록 조회가 설계되어 있어 위험도 낮다. | – | 기록만 |

## 8. Decision

**Sign-off.** 범위(PRD-0001 AC-2·AC-3, TASK-0004 AC-1~4, API-0001 v0.2.0 전체, REVIEW-0002 Operator 결정)의 모든 항목에 증거가 있고 결함은 0건이다. REVIEW-0002 Follow-up Resolution의 "Resolved" 10건을 모두 실제 서버에서 확인했다. QA-0001 흐름의 회귀도 없다. TASK-0004를 Done으로 바꾸고 DevOps에 넘긴다.

## Handoff

| From | To | Artifact |
|------|-----|----------|
| QA | DevOps | 이 리포트(QA-0002). 배포 시 참고: 마이그레이션 2가 서버 시작 시 자동 적용됨(#55), QA-0001 O1·O2, REVIEW-0002 N3(TASK-0008) |
| QA | Frontend / PM | 관찰 O1·O3·O4 (TASK-0007 UI 처리 참고) |
