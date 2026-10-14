# Deployment Record: REL-0001 — 계정·워크스페이스 API (기능 꺼진 상태로 배포)

| Field | Value |
|-------|-------|
| Release ID | REL-0001 |
| Date | 2026-10-14 |
| PR | [#9](https://github.com/as950118/tacet/pull/9), merge commit `bd02925` |
| Tasks | TASK-0002, TASK-0003, TASK-0004 (모두 QA Sign-off: QA-0001, QA-0002) |
| Approver | heonjinjeong (Operator): "지금 바로 PR+머지" |
| Targets | Render `tacet-api` (main 자동 배포), Vercel 대시보드 (production) |

## 전략

두 단계로 나눠 배포한다.
1. 코드를 배포하되 `TACET_ACCOUNTS`를 설정하지 않아 회원 기능은 꺼 둔다. 운영 동작은 바뀌지 않는다. ← 이번 릴리스
2. TASK-0011(PG 동시성 멈춤)을 고치고 배포한 뒤, Render에 `TACET_ACCOUNTS=true`와 `TACET_TRUST_PROXY=true`를 넣어 회원 기능을 켠다(Operator 결정).

## Gates

| Gate | 결과 |
|------|------|
| Review | REVIEW-0001, REVIEW-0002 Approved |
| QA | QA-0001, QA-0002 Sign-off |
| CI | PR #9: test (Node 22), test (Node 24), deploy-artifacts, Vercel 모두 pass |

## 배포 후 확인

| 확인 항목 | 결과 |
|-----------|------|
| `GET /health` | `{"status":"ok","version":"0.1.2","readOnly":true,"accounts":false,"index":{"dialect":"postgres",…}}`, 머지 후 약 60초 만에 반영 |
| `GET /projects`를 토큰 없이 호출 | 401 (기존과 같음) |
| `POST /auth/login` | 404 (회원 기능 꺼짐) |
| `/openapi.json` | `/auth/*` 없음 |
| Vercel production | `bd02925` 배포 success |
| 토큰으로 `/projects`, 대시보드 프로젝트 목록 | 미확인. 운영 토큰이 로컬에 없어 Operator가 확인해야 한다. |

## Rollback

회원 기능이 꺼져 있어 데이터 변경은 없었다. Supabase에 계정 테이블도 아직 만들어지지 않았다(`--accounts`일 때만 마이그레이션이 실행된다). 되돌려야 하면 Render에서 이전 배포로 rollback하거나 `bd02925`를 revert한다.

## Known Issues

- TASK-0011: PostgreSQL에서 동시 가입·생성 테스트가 약 1/20 확률로 정리(teardown) 단계에서 멈춘다. 이 문제가 고쳐져 배포되기 전까지 2단계는 진행하지 않는다.
