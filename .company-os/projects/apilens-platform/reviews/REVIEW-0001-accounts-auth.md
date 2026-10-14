# Review Report: REVIEW-0001 — 계정 테이블·자체 인증 (TASK-0002, TASK-0003)

| Field | Value |
|-------|-------|
| Review ID | REVIEW-0001 |
| Tasks | [TASK-0002](../../../tasks/TASK-0002.md), [TASK-0003](../../../tasks/TASK-0003.md) |
| Commits | `965b9df` (account tables), `bcb1365` (sign-up, login, sessions) |
| Branch | `feature/platform-workspaces` |
| Reviewer | Reviewer Agent (Claude) |
| Date | 2026-10-14 |
| Reviewer 권고 | **Approve with follow-ups**: Blocker 0, Major 1, Minor 2, Nit 2 |
| Gate 결정 | **Approved** (2026-10-14, heonjinjeong) → QA handoff |

## Inputs

- PRD-0001, ADR-0002 (Accepted), `company/coding-principles.md`, `skills/code-review.md`
- `/security-review` 결과 (2026-10-14): 서브에이전트가 변경 코드를 분석했다. 문서·스킬 scaffolding과 테스트 파일은 제외했다.
- 테스트 결과: 전체 224 통과. PostgreSQL에서는 `TACET_TEST_POSTGRES_URL`로 플랫폼·서버 테스트 44개가 통과했다.

## Security Review 요약

신뢰도 8/10 이상인 HIGH/MEDIUM 취약점은 **없음**.

| 영역 | 확인 내용 | 결과 |
|------|-----------|------|
| 인가 | `server.ts` `admit()`: route 기본값은 `machine`이다. 토큰을 설정하면 사용자 세션은 machine 라우트에서 401을 받고, machine 토큰은 `/me`·`/auth/logout`에서 401을 받는다. | 안전 |
| 토큰 미설정 폴백 | 기존과 동일하다. non-loopback 리스닝은 여전히 `--token`을 요구한다. | 확대 없음 |
| machine 토큰 비교 | 길이 확인 후 `timingSafeEqual`을 쓴다. 빈 bearer는 anonymous로 처리한다. | 안전 |
| 세션 | 32바이트 랜덤 토큰을 쓰고 sha256 해시만 저장한다. 조회는 파라미터화되어 있다. 만료 검사가 연장보다 먼저 일어나고, 로그아웃은 행을 삭제한다. | 안전 |
| 비밀번호 | scrypt(N=2^15, r=8, p=3), 16바이트 salt, `timingSafeEqual`. 저장 해시는 서버만 만든다. 256자 초과 입력은 항상 실패한다. | 안전 |
| 로그인 열거 | 없는 이메일도 `UNUSABLE_PASSWORD_HASH`로 같은 비용의 scrypt를 수행하고, 오류 메시지는 하나로 같다. | 안전 |
| SQL 인젝션 | 계정 쿼리는 모두 파라미터화되어 있다. 마이그레이션 DDL에는 상수만 들어간다. | 안전 |
| 응답·로그 노출 | `toUser()`는 id·email·displayName·createdAt만 돌려준다. 500 오류 로그에 바인딩 파라미터는 포함되지 않는다. | 안전 |
| 헤더 | `HttpError` 헤더는 서버가 정한 고정값(`WWW-Authenticate`, 숫자 `Retry-After`)뿐이다. | 안전 |
| CSRF | 쿠키 없이 Bearer 헤더만 쓰므로 `--cors`를 켜도 노출이 없다. | 해당 없음 (쿠키는 TASK-0006에서 재검토) |
| XSS | `web/components/PagesView.tsx`에 `dangerouslySetInnerHTML`이 없다. | 안전 |

알려진 trade-off: 취약점으로 분류하지 않고 ADR·Task에 기록되어 있다.
- 가입 시 이메일이 중복되면 409를 돌려줘 가입 여부가 드러난다. 의도된 결정이며 TASK-0010에서 재검토한다.
- `--trust-proxy`의 X-Forwarded-For는 위조할 수 있다. 영향은 IP 기준 스로틀 키에 한정되고, 이메일 기준 키는 그대로 유효하다.
- 로그인 스로틀은 인스턴스 메모리에 있다(ADR-0002). 단일 인스턴스를 전제로 한다.

## Findings

| # | Severity | Area | Finding | Action |
|---|----------|------|---------|--------|
| R1 ✅ | **Major** | Docs | DoD의 "Docs 동기화"가 미충족이다. `README.md`, `ARCHITECTURE.md`, `DEPLOY.md`에 `serve --accounts`, `--trust-proxy`, `TACET_ACCOUNTS`, `TACET_TRUST_PROXY`, `tacet platform migrate`, 계정 테이블 설명이 없다. | Backend: QA 전에 문서를 갱신한다. |
| R2 ✅ | Minor | Data lifecycle | 만료된 세션은 그 토큰이 다시 제시될 때만 삭제된다(`accounts.ts:93`). 다시 쓰이지 않는 세션 행은 `sessions`에 영원히 남는다. | Backend: `migrate`나 서버 시작 시, 또는 주기적으로 `DELETE FROM sessions WHERE expires_at < now`를 실행한다. TASK-0004에서 같이 처리해도 된다. |
| R3 | Minor | Observability | 가입, 로그인 실패, 스로틀 발동을 로그나 메트릭으로 남기지 않는다(coding-principles #7). | Backend: 이메일과 토큰 없이 이벤트 수만 기록한다. TASK-0008 배포 전까지 처리한다. |
| N1 | Nit | Small Diffs | `965b9df`에 scaffolding(문서 100여 개)과 마이그레이션 코드가 한 커밋으로 섞여 있다(coding-principles #2). | 이후 커밋은 의도 하나씩으로 나눈다. |
| N2 | Nit | Explicit Interfaces | 새 API의 스펙은 자동 생성되는 OpenAPI(`/openapi.json`)에만 있고 `projects/apilens-platform/api/`는 비어 있다. | TASK-0004 API를 설계할 때 API Spec 문서를 추가한다. |

변경 범위 밖이라 이번 결정에는 반영하지 않은 참고 사항:
- `web/proxy.ts`는 Basic auth 비밀번호를 `===`로 비교한다. 이 파일은 TASK-0006에서 세션 쿠키 방식으로 교체될 예정이다.
- 4xx/5xx 응답이 오류 메시지를 그대로 클라이언트에 돌려준다.

## Decision

- **Reviewer 권고: Approve with follow-ups.** Blocker가 없고 보안 검토도 통과했다. R1(Major, 문서)은 QA Sign-off 전에 처리해야 한다.
- **Gate 승인: 대기.** 작성자와 Reviewer가 동일 에이전트이므로 self-approve하지 않는다. 사람(CEO/Operator)이 이 리포트를 보고 Approve하면 `Approval Record`를 아래에 추가하고 QA로 handoff한다.

## Approval Record

| Date | Approver | Decision | Note |
|------|----------|----------|------|
| 2026-10-14 | heonjinjeong (Operator) | Approve | Reviewer 권고(Approve with follow-ups)를 승인했다. R1·R2는 승인 직후 처리하라고 지시했다. |

## Follow-up Resolution

| # | Status | Resolution |
|---|--------|------------|
| R1 | Resolved | `README.md`에 "회원 (`--accounts`, 개발 중)" 절을 추가했다. `ARCHITECTURE.md` §7에 계정 테이블을, §12에 회원 principal을, `DEPLOY.md` §3에 회원 기능 환경변수를 추가했다. |
| R2 | Resolved | `PlatformAccounts.purgeExpiredSessions()`를 추가했다. 서버는 `--accounts`일 때 시작 시와 매시간 이를 실행한다(`clearInterval`은 close 시). 테스트를 추가했고 전체 225개가 통과했다(PG 포함). |
| R3 | Open → TASK-0008 | 배포 전에 인증 이벤트 수를 기록한다. |
| N1, N2 | Open | N1: 이후 커밋은 의도 하나씩으로 나눈다. N2: TASK-0004에서 API Spec 문서를 작성한다. |

## Handoff

| From | To | Artifact |
|------|-----|----------|
| Reviewer | QA | 이 리포트(Approval Record). QA 대상: PRD-0001의 AC-1(API 부분), AC-7(기존 라우트·토큰 호환). 테넌트 격리(AC-9)는 TASK-0005 이후 TASK-0009에서 검증한다. |
