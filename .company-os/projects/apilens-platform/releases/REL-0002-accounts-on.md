# Deployment Record: REL-0002 — 회원 기능 켜기 + 시작 시 정리 hotfix

| Field | Value |
|-------|-------|
| Release ID | REL-0002 |
| Date | 2026-10-14 |
| PRs | [#10](https://github.com/as950118/tacet/pull/10) (`6e09874`), [#11](https://github.com/as950118/tacet/pull/11) (`82a7718`) |
| Approver | heonjinjeong (Operator): 환경변수를 직접 추가하고 "형상관리도 해주고, 배포도 해줘"라고 지시 |
| Targets | Render `tacet-api` |

## 변경

1. Operator가 Render 대시보드에서 `TACET_ACCOUNTS=true`와 `TACET_TRUST_PROXY=true`를 추가했다. 서비스가 재시작되며 Supabase에 계정 테이블이 생성됐다.
2. PR #10: 같은 두 값을 `render.yaml`에 넣어 형상관리에 포함했다. `DEPLOY.md`도 갱신했다.
3. PR #11 (hotfix): 서버 시작 시 만료된 세션·초대 정리를 끝까지 기다린 뒤 요청을 받도록 했다.

## 배포 후 확인

| 확인 항목 | 결과 |
|-----------|------|
| `GET /health` | `"accounts":true`, `"readOnly":true` |
| 존재하지 않는 이메일로 로그인 | 401 `Wrong email or password`. 계정 테이블 조회가 정상이다. |
| `GET /me`를 토큰 없이 호출 | 401 |
| `/openapi.json` | `/workspaces` 라우트 8개 |
| 가입 시험 | 하지 않았다. 계정 삭제 API가 없어 시험 계정이 운영 DB에 남기 때문이다. |

## Incident: CI가 실패한 PR을 머지함

- PR #10의 CI 테스트(Node 22·24)가 실패했는데 머지됐다. 저장소에 브랜치 보호가 없고, 머지 명령이 CI 결과 확인 없이 이어서 실행됐다.
- 실패 원인은 PR #10이 아니라 PR #9부터 `main`에 있던 경합이다. 시작 시 정리가 fire-and-forget이라, CI의 느린 PostgreSQL에서 QA-0002 테스트가 간헐적으로 실패했다. PR #11로 고쳤고 `main` CI는 다시 통과한다.
- 영향: PR #10은 설정과 문서만 바꿨으므로 운영 영향은 없다.
- 재발 방지:
  - 머지 전에 CI가 모두 pass인지 확인한다(lessons-learned).
  - `main`에 브랜치 보호(required checks)를 켤 것을 권고한다. Operator 결정이 필요하다.

## Known Issues

- TASK-0011(PG 동시성 멈춤)은 아직 수정 중이다. 회원 기능은 Operator 결정으로 먼저 켰다.
