# PRD: 회원 · 워크스페이스 · 프로젝트 관리 (플랫폼화 1단계)

| Field | Value |
|-------|-------|
| PRD ID | PRD-0001 |
| Status | Approved |
| Author | PM |
| Product | ApiLens Platform |
| Priority | P0 |
| Created | 2026-10-14 |

## 1. Problem Statement

지금 ApiLens는 단일 운영자용이다. 프로젝트는 문자열 이름 하나로만 구분되고(`index_meta.project`), API는 공유 Bearer 토큰 하나(`TACET_API_TOKEN`), 대시보드는 사이트 전체 Basic auth(`DASHBOARD_USER`/`DASHBOARD_PASSWORD`)로만 보호된다. 그래서 여러 사람이나 팀이 각자 자기 프로젝트만 보고 관리할 수 없다.

## 2. Goals

- 사용자가 가입하고 로그인할 수 있다.
- 사용자는 워크스페이스를 만들고 멤버를 초대하며 역할을 부여할 수 있다.
- 프로젝트는 워크스페이스에 속하고, 멤버만 조회할 수 있으며 권한이 있는 멤버만 변경할 수 있다.
- 기존 CLI/CI/MCP 흐름(로컬 SQLite, 공유 토큰)은 깨지지 않는다.

## 3. Non-Goals

- 결제·요금제·사용량 과금
- SSO/SAML, 감사 로그(audit log)
- 워크스페이스별 API 키(→ PRD-0002 후보, CLI push 인증용)
- 서버 측 저장소 연동(GitHub App 등)

## 4. Acceptance Criteria

- [ ] AC-1: 이메일/비밀번호로 가입·로그인·로그아웃할 수 있다. 세션은 대시보드 쿠키로 유지된다.
- [ ] AC-2: 처음 로그인하면 개인 워크스페이스가 자동으로 생성되고, 그 사용자가 owner가 된다.
- [ ] AC-3: owner/admin은 이메일로 멤버를 초대하고 역할(owner/admin/member/viewer)을 바꾸거나 멤버를 제거할 수 있다. 마지막 owner는 제거하거나 강등할 수 없다.
- [ ] AC-4: 워크스페이스 안에서 프로젝트를 생성·이름변경·삭제할 수 있다(admin 이상). 프로젝트 slug는 워크스페이스 안에서만 유일하면 된다.
- [ ] AC-5: 분석 조회 API(`/pages`, `/impact`, `/unused` 등)는 해당 워크스페이스 멤버에게만 응답한다. 비멤버에게는 404를 돌려준다(존재 여부를 노출하지 않음).
- [ ] AC-6: 쓰기 API(`/frontend`, `/backend`, `/analyze`, `DELETE`)는 member 이상만 호출할 수 있다.
- [ ] AC-7: 기존 `/projects/{name}` 경로와 `TACET_API_TOKEN`은 머신 클라이언트(CLI/CI/MCP)용으로 계속 동작한다. 로컬 SQLite 모드에서는 플랫폼 기능이 꺼진다.
- [ ] AC-8: 기존 인덱스 프로젝트는 마이그레이션 스크립트로 지정한 워크스페이스에 귀속된다. 인덱스는 재생성하지 않는다.
- [ ] AC-9: 워크스페이스 간 격리를 검증하는 자동 테스트가 있다(A 멤버가 B의 프로젝트에 접근할 수 없음).

## 5. Scope

### In Scope
- 자체 인증: 가입/로그인/로그아웃, scrypt 비밀번호 해시, 불투명 세션 토큰(ADR-0002)
- 컨트롤 플레인 스키마(workspaces, members, invites, projects)와 마이그레이션 러너
- 워크스페이스/멤버/프로젝트 REST API(`server.ts` 라우트 테이블 확장, OpenAPI 자동 반영)
- 대시보드: 로그인/가입 화면, 워크스페이스 스위처, 프로젝트·멤버 관리 화면

### Out of Scope
- §3 Non-Goals 전체
- OAuth 공급자(GitHub/Google) 로그인
- 이메일 확인과 비밀번호 재설정 (TASK-0010, 메일 공급자 필요)

## 6. Assumptions

- 운영 DB는 이미 쓰고 있는 Supabase Postgres를 그대로 쓴다(DB로만 사용). 로컬은 SQLite.
- 인덱스 테이블은 계속 캐시로 취급한다. 테넌시는 별도의 `projects` 매핑 테이블로 표현하고, 인덱스의 키는 불변 ID를 쓴다.

## 7. NFR (Draft)

- 보안: 비밀번호는 scrypt, 세션 토큰은 해시로만 저장, 로그인 실패 레이트 리밋. 권한 검사는 모든 요청마다 서버에서 한다. 클라이언트 표시용 데이터는 신뢰하지 않는다.
- 성능: 권한 조회로 인한 요청당 추가 지연은 p95 기준 20ms 이하로 한다(멤버십을 짧게 캐시).
- 호환성: 기존 Vitest/pytest 스위트가 모두 통과해야 한다.

## 8. Open Questions

| # | Question | Owner | Due |
|---|----------|-------|-----|
| 1 | ~~인증 공급자~~ → 자체 구현 (ADR-0002 Accepted, 2026-10-14) | CEO | 해결 |
| 2 | ~~가입 정책~~ → 공개 가입 (2026-10-14) | CEO | 해결 |
| 3 | 프로젝트 데이터를 워크스페이스 간에 공유할 필요가 있는지 (현재 계획: 없음) | PM | TASK-0005 |

## 9. References

- `/ARCHITECTURE.md`, `/DEPLOY.md`
- ADR-0002 (`../adr/ADR-0002-auth-and-tenancy.md`)
- Tasks: TASK-0001 ~ TASK-0010 (`.company-os/tasks/`)
