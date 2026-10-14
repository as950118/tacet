# Review Report: REVIEW-0002 — 워크스페이스·멤버·초대 API (TASK-0004)

| Field | Value |
|-------|-------|
| Review ID | REVIEW-0002 |
| Tasks | [TASK-0004](../../../tasks/TASK-0004.md) |
| Commits | `d6687e9` (workspaces, members, invites; `f423627` 대비 diff) |
| Branch | `feature/platform-workspaces` |
| Reviewer | Reviewer Agent (Claude) |
| Date | 2026-10-14 |
| Reviewer 권고 | **Approve with follow-ups**: Blocker 0, Major 1, Minor 5, Nit 3 |
| Gate 결정 | **대기 (사람 승인 필요)**: 구현자와 Reviewer가 같은 모델이므로 self-approve하지 않는다. |

## Inputs

- TASK-0004, PRD-0001(AC-2, AC-3, AC-5), ADR-0002 (Accepted), API-0001 v0.1.0, `company/coding-principles.md`, `skills/code-review.md`
- 보안 검토: 변경 코드(`packages/core/src/platform/workspaces.ts`, `accounts.ts`, `packages/cli/src/server.ts`)를 인가 로직 중심으로 직접 분석했다. 실제로 악용할 수 있다는 신뢰도가 80% 이상인 것만 취약점으로 보고한다. DoS, 레이트 리밋, 자원 고갈은 제외했다.
- 재현 스크립트: 빌드된 `packages/core/dist`, `packages/cli/dist`를 대상으로 R1·R2 재현, 경로 매처 경계값, 워크스페이스 간 IDOR를 HTTP로 확인했다. 스크립트는 세션 scratchpad에만 두었고 저장소는 바꾸지 않았다.
- 테스트 결과:
  - `npm run build`: 성공
  - `npm test`: 19 files, **247 통과** (이 중 워크스페이스 테스트 15개: core 10, HTTP 5)
  - `TACET_TEST_POSTGRES_URL=… npm test`: 19 files, **296 통과** (PostgreSQL 전용 49개 추가, 워크스페이스 테스트는 PG에서 14개 더 돌아 29개)

## Security Review 요약

신뢰도 8/10 이상인 HIGH/MEDIUM 취약점은 **없음**. 인가 강화가 필요한 항목 하나(R1)는 Major로 분류했다. 재현은 되지만 owner가 대기 중인 초대 목록에서 발견하고 취소할 수 있고, 권한 상승이 아니라 이미 가졌던 권한이 남는 문제이기 때문이다.

| 영역 | 확인 내용 | 결과 |
|------|-----------|------|
| 역할 변경으로 권한 상승 | admin이 자신을 owner로: `mayManage(admin, admin)`이 막는다(`workspaces.ts:439-441`). owner 수정: `mayManage`가 막는다. admin 부여: `mayGrant`가 막는다(`:443-445`). admin이 owner/admin 초대: `mayGrant`가 막는다(`:240`). 역할 값은 body `enum`과 `checkRole`로 이중 검증한다. | 안전 |
| 마지막 owner | 강등(`:192`), 제거(`:205`), 탈퇴(`:213`), `DELETE …/members/{me}`(→ leave) 모두 `keepAnOwner`를 거친다. 모든 경로가 `workspace:<id>` 잠금 트랜잭션 안에서 실행되고, 호출자 역할도 잠금 안에서 id로 다시 읽는다(`:340-343`). PG는 `pg_advisory_xact_lock`, SQLite는 프로세스 내 직렬화와 `BEGIN IMMEDIATE`다. 동시 강등 테스트도 있다. | 안전 |
| 소유권 이전 | `need(ws.role, "owner")`(`:221`). 대상은 같은 워크스페이스 멤버여야 한다(`memberOf`). | 안전 |
| 워크스페이스 간 IDOR | `memberOf`(`:357`)와 `revokeInvite`(`:283`)가 `workspace_id`로 범위를 제한한다. HTTP 확인: `PATCH /workspaces/team/members/{B의 사용자}` → 404, `DELETE /workspaces/team/invites/{B의 초대}` → 404. | 안전 |
| 비멤버 404 | 모든 메서드가 `membership()`(`:347`)을 먼저 거친다. 역할 검사(403)는 그 뒤다. 경로 파라미터 형식 오류(400)는 멤버십보다 먼저 나오지만, 존재 여부와 무관하다. | 안전 |
| 초대 토큰 | `randomBytes(32)`, sha256 해시만 저장, `token_hash UNIQUE`. 한 번만 쓸 수 있다(`accepted_at`, `invite:<hash>` 잠금). 만료는 수락 시점에 검사한다(`:308`). 취소하면 행을 삭제하므로 이후 수락은 404다. 초대 역할은 생성 시 `mayGrant`로 제한된다. | 안전 (R1·R2·R3 참고) |
| 가입 롤백 | `signUp`이 사용자 INSERT와 `onSignUp`(개인 워크스페이스)을 한 트랜잭션에서 실행한다(`accounts.ts:65-74`). 테스트로 고아 행이 남지 않음을 확인했다. | 안전 (R4: 동시 가입 시 500) |
| SQL 인젝션 | 모든 값은 `?` 바인딩이다. 유일한 동적 SQL은 `membership()`의 `${id ? "w.id" : "w.slug"}`로, 상수 컬럼명만 들어간다. `numbered()`의 `?` 치환과 충돌하는 문자열 리터럴도 없다. | 안전 |
| 경로 매처 | `decodeURIComponent` 실패 시 400(`%zz`), 디코딩 후 `PATH_PARAMS` 정규식으로 검증한다(`x%2Fy` → 400). 리터럴 비교는 디코딩 전 세그먼트로 하므로 인코딩으로 리터럴을 우회할 수 없다(`te%61m`은 파라미터로만 해석). `..`은 `URL`이 먼저 정규화한다. `access`는 선택된 라우트마다 `admit()`이 검사하므로 매칭 결과와 관계없이 건너뛸 수 없다. 현재 라우트 테이블에서 리터럴과 파라미터가 겹치는 경로는 없다. | 안전 (R6: TASK-0005 준비) |
| CORS `PATCH` | 인증은 `Authorization: Bearer` 헤더뿐이고 쿠키·`Allow-Credentials`가 없다. 교차 출처 페이지는 토큰 없이 요청할 수 없으므로 위험이 늘지 않는다. | 해당 없음 (쿠키는 TASK-0006에서 재검토) |

알려진 trade-off: 취약점으로 분류하지 않았다.
- 초대 수락은 이메일이 아니라 토큰으로 증명한다(ADR-0002 §인증). 링크가 유출되면 누구든 그 역할로 들어올 수 있다. 메일 발송(TASK-0010) 전까지는 의도된 결정이다.
- 모든 멤버(viewer 포함)가 다른 멤버의 이메일을 볼 수 있다. API-0001 역할 매트릭스대로다.

## Findings

| # | Severity | Area | Finding | Action |
|---|----------|------|---------|--------|
| R1 | **Major** | Security / Authz | **초대 권한이 수락 시점에 다시 검사되지 않는다.** 초대는 만든 사람의 권한으로 검증되지만(`workspaces.ts:239-240`), 수락(`:295-337`)은 그 사람이 아직 멤버인지, 아직 그 역할을 부여할 수 있는지 보지 않는다. 그래서 제거되거나 강등된 admin이 미리 만들어 둔 초대로 다시 들어올 수 있다. **재현**: owner가 A를 admin으로 들인다 → A가 `createInvite(A, "team", {email:"alt@x.com", role:"member"})`로 토큰을 받아 둔다 → owner가 `removeMember(owner, "team", A)` → `get(A, "team")`은 `not-found` → A가 `acceptInvite(A, token)`하면 role `member`로 다시 들어온다. 멤버는 TASK-0005 이후 인덱스 쓰기(PRD AC-6)까지 할 수 있다. | Backend: QA Sign-off 전에 고친다. (a) 멤버를 제거·강등하거나 멤버가 탈퇴할 때, 그 사람이 만든 대기 초대 중 새 역할로는 부여할 수 없는 것을 같은 잠금 트랜잭션에서 삭제한다. 또는 (b) 수락할 때 `invited_by`의 현재 역할로 `mayGrant`를 다시 검사한다. 어느 쪽이든 회귀 테스트를 추가하고 API-0001에 적는다. |
| R2 | Minor | Authz consistency | admin이 자기보다 높은 역할의 대기 초대를 지울 수 있다. `revokeInvite`(`:279-289`)는 초대의 역할을 보지 않고, 같은 이메일로 다시 초대하면(`:246`) 역할과 관계없이 기존 초대를 삭제한다. **재현**: owner가 `cto@x.com`을 owner로 초대 → admin이 `revokeInvite`하면 삭제된다. 권한 상승은 아니지만 "자기보다 낮은 역할만 다룬다"는 규칙(API-0001)과 어긋난다. | Backend: 취소·대체 대상 초대에도 `mayGrant(ws.role, invite.role)`를 적용한다. |
| R3 | Minor | Concurrency | `acceptInvite`는 `invite:<hash>` 잠금만 쓰고(`:336`) 워크스페이스 잠금을 쓰지 않는다. PG READ COMMITTED에서 수락이 초대를 읽은 직후 취소(또는 재초대 대체)가 커밋되면, `UPDATE … accepted_at`(`:309`)은 0행을 바꾸고 멤버 INSERT(`:317`)는 그대로 진행된다. 취소가 커밋된 뒤에 가입이 성공하는 셈이다. 창이 수 ms이고 공격자가 원래 수락할 수 있었던 토큰이라 악용 가치는 낮다. | Backend: 토큰으로 `workspace_id`를 먼저 찾은 뒤 `workspace:<id>` 잠금 트랜잭션 안에서 초대를 다시 읽는다. R1 수정과 함께 처리하면 된다. |
| R4 | Minor | Fail Loud / 오류 처리 | slug 경합이 500이 된다. (1) PG에서 로컬 파트가 같은 두 사용자(`dev@a.com`, `dev@b.com`)가 동시에 가입하면 `freeSlug`(`:399`)가 같은 slug를 고르고, 한쪽은 unique 위반으로 롤백된다. `signUp`의 catch(`accounts.ts:75-78`)는 이메일 중복만 409로 바꾸므로 원시 DB 오류가 500으로 나간다. (2) `create()`에서 slug를 생략한 경우도 같다(`:116`은 slug를 지정했을 때만 다시 검사한다). 데이터는 롤백되어 정합성 문제는 없다. | Backend: unique 위반이면 새 접미사로 한두 번 재시도하거나 409로 바꾼다. |
| R5 | Minor | Test Pyramid | 핵심 보안 경계 몇 개에 자동 테스트가 없다. 워크스페이스 간 IDOR(`/workspaces/A/members/{B의 사용자}`, `/workspaces/A/invites/{B의 초대}`), 매처(리터럴 우선순위, 전역 라우트 405, 잘못된 퍼센트 인코딩 400, 인코딩된 슬래시), 동시 수락. Reviewer가 HTTP로 직접 확인했고 모두 기대대로 동작했다. | Backend: `server-workspaces.test.ts`에 추가한다. 테넌트 격리 전체 검증은 TASK-0009(PRD AC-9)다. |
| R6 | Minor | 설계 / TASK-0005 준비 | 매처는 TASK-0005에 쓸 만하다. 템플릿, 세그먼트 단위 비교, 리터럴 우선, 405 처리, OpenAPI 파라미터 생성이 한곳에 모여 있다. 다만 다음 세 가지는 TASK-0005 전에 정해야 한다. (1) `PATH_PARAMS`에 없는 `{name}`은 아무 검증 없이 통과한다(`server.ts:633-634`, `if (param && …)`). TASK-0005의 `{slug}`를 빠뜨려도 조용히 동작한다. (2) 같은 (method, template)의 중복 등록을 감지하지 않는다. 먼저 등록된 라우트가 이긴다. (3) 인덱스 작업 공간 선택과 쓰기 직렬화가 `params.project`가 있는지에 달려 있다(`:526-528`). `/workspaces/{ws}/projects/{slug}`에서는 slug를 `index_key`로 바꾸고 멤버십·역할을 먼저 검사해야 한다. 파라미터 이름이 아니라 마운트(scope)별로 처리해야 한다. | Backend: (1)·(2)는 서버 시작 시 예외를 던지게 바꾼다(Fail Loud). (3)은 TASK-0005 설계에 반영한다. |
| N1 | Nit | Docs | PRD-0001 AC-2와 TASK-0004 Summary는 "처음 로그인하면" 개인 워크스페이스를 만든다고 적었는데, 구현과 API-0001은 가입 시점이다. | PM: PRD 문구를 구현에 맞추거나 OQ-2 결정에 따라 정리한다. |
| N2 | Nit | Explicit Interfaces | `transfer`의 대상이 자기 자신이면 아무것도 바꾸지 않고 200을 준다(`:223`). 대상이 이미 owner이면 호출자만 admin이 된다. 둘 다 API-0001에 없다. | Backend: API-0001에 한 줄 추가하거나, 자기 자신이면 400으로 바꾼다. |
| N3 | Nit | Observability | 역할 변경, 제거, 소유권 이전, 초대 수락을 로그로 남기지 않는다(coding-principles #7). 감사 로그는 PRD Non-Goal이므로 이벤트 수만 남기면 된다. | REVIEW-0001 R3와 함께 TASK-0008에서 처리한다. |

### ADR·API 정합성

- ADR-0002 역할 정의(viewer GET, member 쓰기, admin 프로젝트 CRUD·초대, owner 삭제·이전)와 일치한다. 스키마 변경이 없어 마이그레이션 1 테이블 그대로다.
- API-0001의 경로, 상태 코드, 스키마는 코드(`workspaceRoutes()`, `statusOf()`)와 일치한다. README·ARCHITECTURE도 갱신되어 DoD "Docs 동기화"를 충족한다. 불일치는 N1·N2뿐이다.
- 매처 교체는 ADR이 필요한 패턴 변경이 아니라 기존 라우트 테이블의 확장으로 본다. 기존 `/projects/{project}` 동작(400, 405, 404)은 그대로이며 기존 테스트가 모두 통과한다.

## 구현자 Open Questions에 대한 의견

| # | 질문 | 판단 | 근거 |
|---|------|------|------|
| OQ-1 | admin은 admin을 부여·변경할 수 없다(엄격한 "자기보다 낮은 역할"). PRD AC-3은 모호하다. | **PM 결정** (Block 아님) | 지금 구현이 더 안전한 기본값이고, 나중에 완화해도 호환성이 깨지지 않는다. AC-3 문구("owner/admin은 … 역할을 바꾸거나")를 PM이 확정해 PRD와 API-0001 역할 매트릭스에 반영한다. |
| OQ-2 | 개인 워크스페이스는 가입할 때만 만든다. 그 전에 가입했거나 삭제한 사용자는 없다. `/workspaces`에서 지연 생성할까? | **PM 결정 + follow-up** (Block 아님) | 아직 배포 전이라 기존 사용자는 개발·QA DB에만 있다. `GET`에서 쓰기를 하는 지연 생성은 권하지 않는다. "항상 하나는 있어야 한다"가 요구사항이면 로그인 시 생성하거나 일회성 백필 마이그레이션을 쓴다. 사용자가 삭제한 경우 다시 만들지 여부도 PM이 정한다(N1과 함께). |
| OQ-3 | 워크스페이스를 지우면 `workspace_projects`는 cascade되지만 인덱스 데이터 정리는 TASK-0005 몫이다. | **Follow-up → TASK-0005** | 프로젝트를 만드는 API가 아직 없어 지금은 고아 인덱스 데이터가 생길 수 없다. TASK-0005 AC에 "워크스페이스·프로젝트 삭제 시 `index_key`의 인덱스 데이터 삭제(또는 정리 작업)"를 넣는다. |
| OQ-4 | 만료된 초대는 지우지 않는다. | **Follow-up** (Minor) | 만료는 수락 시점에 검사되므로 보안 문제는 없다. REVIEW-0001 R2의 `purgeExpiredSessions` 주기 작업에 만료 초대 삭제를 붙인다. 수락된 초대 행은 이력으로 남길지 PM이 정한다. |
| OQ-5 | slug를 바꾸면 이전 링크가 깨진다. | **PM 결정** (Block 아님) | 지금은 문서화된 동작이다(API-0001). 다만 이전 slug를 다른 사용자가 곧바로 가져갈 수 있으므로, TASK-0005에서 CLI·CI 설정이 slug를 담게 되면 다른 워크스페이스를 가리킬 수 있다. 별칭(redirect) 테이블, 이전 slug 예약 기간, CLI는 불변 id 사용 중 하나를 TASK-0005 전에 정한다. |

## Decision

- **Reviewer 권고: Approve with follow-ups.** Blocker가 없고, 신뢰도 80% 이상의 HIGH/MEDIUM 취약점도 없다. R1(Major, 초대 권한 재검사)은 QA Sign-off 전에 처리해야 한다. R2~R5는 R1과 같은 변경에서 처리할 수 있다. R6은 TASK-0005 착수 전에 처리한다.
- **Gate 승인: 대기.** 작성자와 Reviewer가 같은 모델이므로 self-approve하지 않는다. 사람(CEO/Operator)이 이 리포트를 보고 Approve하면 아래 `Approval Record`를 채우고 QA로 handoff한다.
- OQ-1, OQ-2, OQ-5는 PM 결정이 필요하다. 이번 Gate를 막지는 않는다.

## Approval Record

| Date | Approver | Decision | Note |
|------|----------|----------|------|
| (pending) | (pending) | Pending | 사람 승인 대기. Reviewer 권고는 Approve with follow-ups다. |

## Handoff

| From | To | Artifact |
|------|-----|----------|
| Reviewer | Backend | 이 리포트. R1(필수, QA 전), R2~R5(권장, 같은 변경), R6(TASK-0005 전). |
| Reviewer | PM | OQ-1, OQ-2(+N1), OQ-5 결정 요청 |
| Reviewer | QA | Gate 승인과 R1 해결 후. QA 대상: PRD-0001 AC-2, AC-3, API-0001 전체(비멤버 404, 역할 매트릭스, 마지막 owner, 초대 수명주기). |
