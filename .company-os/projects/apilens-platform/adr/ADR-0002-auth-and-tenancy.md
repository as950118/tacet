# ADR-0002: 인증 공급자와 테넌시 모델

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-10-14 |
| Deciders | Architect, CEO |
| Product | ApiLens Platform |

## Context

PRD-0001에 따라 회원과 워크스페이스 단위 프로젝트 관리를 추가한다. 현재 상황은 다음과 같다.
- 인증은 공유 Bearer 토큰 1개(`server.ts`의 `authorized()`)와 대시보드 Basic auth(`web/proxy.ts`)뿐이다.
- 프로젝트는 문자열 이름이고, 모든 인덱스 테이블 PK의 첫 컬럼이다. 스키마는 `SCHEMA_VERSION`이 바뀌면 재생성하는 캐시다.
- 운영 DB는 Supabase Postgres다. `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`가 `.env`에 이미 있지만, 아직 읽는 코드는 없다.

## Decision Drivers

- 비밀번호 저장·재설정·이메일 확인을 직접 구현하지 않는다.
- API 서버는 무상태로 유지한다(Render free plan, 재시작이 잦음).
- 인덱스 캐시 스키마와 계정 데이터의 수명주기를 분리한다.
- 로컬 SQLite와 CLI 흐름을 유지한다.

## Options Considered

### Option A: Supabase Auth + API 측 JWKS 검증 (권장)
- 대시보드는 `@supabase/ssr`로 쿠키 세션을 관리하고, API 호출 시 access token을 `Authorization: Bearer`로 전달한다.
- API는 `jose`로 `SUPABASE_JWKS_URL`의 공개키를 받아 서명, `exp`, `aud=authenticated`를 검증하고 `sub`를 user id로 쓴다.
- 기존 `TACET_API_TOKEN`은 머신 principal(전체 접근)로 유지한다.

### Option B: 자체 인증 (bcrypt/argon2 + 세션 테이블)
- 외부 의존성은 없다. 대신 비밀번호 재설정, 이메일 확인, 브루트포스 방어, OAuth를 모두 직접 만들어야 한다.

### Option C: Auth.js(NextAuth)를 대시보드에만 적용
- 대시보드는 쉽게 붙는다. 하지만 API 서버가 세션을 검증하려면 별도 토큰 체계가 필요하고, MCP/CLI에서 재사용하기 어렵다.

## Decision

**Option B(자체 인증)**를 채택한다 (2026-10-14, CEO 결정). 가입은 **공개 가입**이다.

### 인증
- API 서버(`packages/cli/src/server.ts`)가 인증 서버 역할을 한다. 글로벌 라우트는 `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /me`다.
- 비밀번호는 `node:crypto`의 scrypt로 해시하며 외부 의존성은 없다. 파라미터는 해시 문자열에 함께 저장해서 나중에 조정할 수 있게 한다(`scrypt$N$r$p$salt$hash`). 길이는 10~256자로 제한한다.
- 세션은 불투명 토큰(32바이트 랜덤)이다. DB에는 sha256 해시만 저장한다. 만료는 30일이고 사용할 때마다 연장하며, 로그아웃이나 비밀번호 변경 시 폐기한다. JWT를 쓰지 않으므로 즉시 폐기할 수 있다.
- 사용자 열거 방지: 없는 이메일로 로그인해도 더미 해시로 scrypt를 한 번 수행한다. 오류 메시지는 하나로 통일한다.
- 브루트포스 방지: IP와 이메일 기준으로 실패 횟수를 제한한다(15분에 10회). 1단계에서는 인스턴스 메모리에 둔다. Render 단일 인스턴스이기 때문이며, 수평 확장 시 DB로 옮긴다.
- 대시보드는 server action으로 `/auth/login`을 호출한다. 받은 토큰은 `httpOnly; Secure; SameSite=Lax` 쿠키에 저장하고, API 호출 시 Bearer로 전달한다. 브라우저 JS는 토큰을 볼 수 없다.
- 이메일 확인과 비밀번호 재설정에는 메일 발송 공급자가 필요하므로 TASK-0010으로 분리한다. 그 전까지 초대는 이메일 일치가 아니라 **초대 링크의 토큰**을 증거로 수락한다(남의 이메일로 가입해 초대를 가로채는 것을 방지).
- 기존 `TACET_API_TOKEN`은 machine principal(전체 접근)로 유지한다.

### 테넌시
- 계정 테이블은 인덱스와 같은 DB(SQLite 또는 Postgres `?schema=`)에 두되, 별도 번호 마이그레이션(`packages/core/src/platform/migrations.ts`)과 `platform_migrations` 테이블로 관리한다. 인덱스 재생성(`SCHEMA_VERSION` 변경)은 이름이 명시된 인덱스 테이블만 DROP하므로 계정 테이블에는 영향이 없다.
  - `users(id, email unique, password_hash, display_name, created_at)`
  - `sessions(token_hash pk, user_id, created_at, expires_at, last_used_at)`
  - `workspaces(id, slug unique, name, created_by, created_at)`
  - `workspace_members(workspace_id, user_id, role ∈ owner|admin|member|viewer, created_at)`, PK `(workspace_id, user_id)`
  - `workspace_invites(id, workspace_id, email, role, token_hash, invited_by, expires_at, accepted_at)`
  - `workspace_projects(id, workspace_id, slug, name, index_key unique, created_at)`, unique `(workspace_id, slug)`
- SQLite와 Postgres 모두 지원한다(`SqlDriver` 재사용). 덕분에 테스트는 SQLite로 돈다.
- 인덱스 테이블은 바꾸지 않는다. `workspace_projects.index_key`(신규는 `p-<uuid>`, 이관된 기존 프로젝트는 원래 이름)를 `IndexDatabase.project(name)`에 넘긴다.
- API 경로는 `/workspaces/{ws}/projects/{slug}/...`이다. 기존 per-project 라우트를 그대로 재사용하고 권한 검사만 앞에 둔다. `/projects/{name}`은 machine 토큰 전용이다.
- 역할: viewer는 GET, member는 쓰기 라우트까지, admin은 프로젝트 CRUD와 초대, owner는 워크스페이스 삭제와 소유권 이전까지 허용한다.
- 플랫폼 기능은 `tacet serve --accounts`(`TACET_ACCOUNTS=true`)로 켠다. 꺼져 있으면 기존 동작과 같다.

## Consequences

### Positive
- 외부 인증 서비스에 종속되지 않는다. SQLite 로컬 모드에서도 똑같이 동작하고 테스트할 수 있다.
- 세션을 즉시 폐기할 수 있다.
- 인덱스 캐시 로직과 기존 테스트에 거의 영향이 없다.

### Negative
- 비밀번호 해시, 레이트 리밋, 세션 관리의 보안 책임이 우리에게 있다. Reviewer는 보안 리뷰(`/security-review`)를 필수로 한다.
- 요청마다 세션을 DB에서 조회한다. 짧은 메모리 캐시로 완화한다.
- 이메일 확인과 비밀번호 재설정은 TASK-0010 전까지 없다.
- `.env`의 `SUPABASE_*` 인증 키는 쓰지 않는다. Supabase는 DB로만 사용한다.

## Rejected Alternatives

| Option | Why Rejected |
|--------|--------------|
| A Supabase Auth | 외부 인증 서비스 종속을 피하고, 로컬/SQLite에서도 동일하게 동작시키기 위해 자체 구현 선택 |
| C Auth.js | API·MCP·CLI에서 같은 신원을 쓰기 어려움 |
| 인덱스 PK에 `workspace_id` 추가 | 캐시 스키마 전면 변경, 이름 변경 시 재색인 필요 |

## Notes

- RLS는 쓰지 않는다. 대시보드는 DB에 직접 붙지 않고 API만 거치며, 권한은 API 서버의 애플리케이션 레이어에서 검사한다.
