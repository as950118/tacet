# API Spec: 워크스페이스·멤버·초대

| Field | Value |
|-------|-------|
| Spec ID | API-0001 |
| Version | v0.1.0 |
| Owner | Backend |
| Base Path | `/` (`tacet serve --accounts`) |
| Product | ApiLens Platform |

관련 문서: PRD-0001(AC-2, AC-3), ADR-0002, TASK-0004. 구현은 `packages/core/src/platform/workspaces.ts`(`PlatformWorkspaces`)와 `packages/cli/src/server.ts`(`workspaceRoutes()`)에 있다. 자동 생성되는 `GET /openapi.json`에도 같은 라우트가 나온다.

## Conventions

- 요청과 응답은 JSON이다. 오류는 `{ "error": "<메시지>" }` 형태다.
- 모든 라우트는 `access: user`다. 세션 토큰을 `Authorization: Bearer <token>`으로 보내야 하며, 없거나 틀리면 401이다. 서버 토큰(machine)으로는 부를 수 없다.
- 경로의 `{ws}`는 워크스페이스 slug다. `{userId}`, `{inviteId}`는 UUID다. 형식이 틀리면 핸들러 전에 400을 돌려준다.
- **존재 여부 비노출**: 호출자가 멤버가 아닌 워크스페이스는 없는 워크스페이스와 똑같이 404다. 멤버이지만 역할이 부족하면 403이다.
- 삭제와 탈퇴처럼 돌려줄 값이 없는 호출은 `{ "ok": true }`를 돌려준다.

### 역할 매트릭스

| 동작 | viewer | member | admin | owner |
|------|:-:|:-:|:-:|:-:|
| 워크스페이스·멤버 조회 | O | O | O | O |
| 이름·slug 변경 | | | O | O |
| 초대 생성·조회·취소 | | | O (member/viewer로만) | O (모든 역할) |
| 역할 변경·멤버 제거 | | | O (member/viewer 대상, member/viewer로만) | O (owner 포함 전부) |
| 소유권 이전·워크스페이스 삭제 | | | | O |
| 탈퇴 | O | O | O | O (마지막 owner 제외) |

- 규칙: owner가 아니면 **자기보다 낮은 역할만** 부여·변경·제거할 수 있다. 그래서 admin은 다른 admin을 만들거나 바꿀 수 없다.
- 마지막 owner는 강등, 제거, 탈퇴 모두 409(`last-owner`)다. 멤버십 변경은 워크스페이스 단위 잠금을 건 트랜잭션에서 실행된다. 그래서 두 owner가 동시에 서로를 강등해도 owner는 한 명 남는다.

## Endpoints

### GET /workspaces

| Item | Value |
|------|-------|
| Summary | 내가 멤버인 워크스페이스 목록(생성 순). 각 항목에 내 역할이 들어 있다. |
| Request | 없음 |
| Responses | 200 `Workspace[]` / 401 |

### POST /workspaces

| Item | Value |
|------|-------|
| Summary | 워크스페이스를 만든다. 호출자가 owner가 된다. |
| Request | `{ name: string(1~100), slug?: string }`. slug를 생략하면 name에서 만든다(겹치면 `-xxxx`를 붙인다). |
| Responses | 200 `Workspace` / 400 name·slug 형식 / 409 slug 중복 |

### GET /workspaces/{ws}

| Item | Value |
|------|-------|
| Summary | 워크스페이스 하나와 내 역할(모든 멤버) |
| Responses | 200 `Workspace` / 404 |

### PATCH /workspaces/{ws}

| Item | Value |
|------|-------|
| Summary | 이름이나 slug를 바꾼다(admin 이상). slug를 바꾸면 이전 slug 경로는 404가 된다. |
| Request | `{ name?: string, slug?: string }` |
| Responses | 200 `Workspace` / 400 / 403 / 404 / 409 slug 중복 |

### DELETE /workspaces/{ws}

| Item | Value |
|------|-------|
| Summary | 워크스페이스와 그 멤버·초대·프로젝트 행을 삭제한다(owner). |
| Responses | 200 `{ok:true}` / 403 / 404 |

### GET /workspaces/{ws}/members

| Item | Value |
|------|-------|
| Summary | 멤버 목록과 역할(모든 멤버) |
| Responses | 200 `Member[]` / 404 |

### PATCH /workspaces/{ws}/members/{userId}

| Item | Value |
|------|-------|
| Summary | 멤버의 역할을 바꾼다(역할 매트릭스 참고). |
| Request | `{ role: "owner" \| "admin" \| "member" \| "viewer" }` |
| Responses | 200 `Member` / 400 역할 형식 / 403 / 404 워크스페이스 또는 멤버 없음 / 409 마지막 owner |

### DELETE /workspaces/{ws}/members/{userId}

| Item | Value |
|------|-------|
| Summary | 멤버를 제거한다(역할 변경과 같은 권한). 자기 자신을 지정하면 탈퇴와 같다. |
| Responses | 200 `{ok:true}` / 403 / 404 / 409 마지막 owner |

### POST /workspaces/{ws}/leave

| Item | Value |
|------|-------|
| Summary | 워크스페이스에서 나간다(마지막 owner 제외). |
| Responses | 200 `{ok:true}` / 404 / 409 마지막 owner |

### POST /workspaces/{ws}/transfer

| Item | Value |
|------|-------|
| Summary | 다른 멤버를 owner로, 호출자를 admin으로 한 번에 바꾼다(owner). 바뀐 멤버 목록을 돌려준다. |
| Request | `{ userId: string }` |
| Responses | 200 `Member[]` / 403 / 404 |

### GET /workspaces/{ws}/invites

| Item | Value |
|------|-------|
| Summary | 아직 수락되지 않은 초대(만료된 것 포함, `expiresAt`으로 구분). admin 이상. 토큰은 들어 있지 않다. |
| Responses | 200 `Invite[]` / 403 / 404 |

### POST /workspaces/{ws}/invites

| Item | Value |
|------|-------|
| Summary | 이메일로 초대한다(admin 이상, 부여 가능한 역할까지). 메일 발송(TASK-0010)이 없으므로 응답에 **토큰을 한 번만** 담아 준다. 호출자가 링크로 전달한다. |
| Request | `{ email: string, role: Role }` |
| Responses | 200 `CreatedInvite` / 400 이메일·역할 형식 / 403 / 404 / 409 이미 멤버인 이메일 |

- 토큰은 32바이트 랜덤 값이다. DB에는 sha256 해시만 저장한다. 7일 동안 유효하며 한 번만 쓸 수 있다.
- 같은 이메일로 다시 초대하면 대기 중인 이전 초대를 지우고 새 토큰을 발급한다.

### DELETE /workspaces/{ws}/invites/{inviteId}

| Item | Value |
|------|-------|
| Summary | 대기 중인 초대를 취소한다(admin 이상). 그 토큰은 더 이상 쓸 수 없다. |
| Responses | 200 `{ok:true}` / 403 / 404 |

### POST /invites/accept

| Item | Value |
|------|-------|
| Summary | 로그인한 상태에서 초대 토큰을 제시해 워크스페이스에 들어간다. 초대 이메일과 계정 이메일이 달라도 된다(ADR-0002). `accepted_at`과 `accepted_by`를 기록한다. |
| Request | `{ token: string }` |
| Responses | 200 `Workspace` / 400 토큰 누락 / 401 / 404 없거나 취소된 초대 / 409 이미 사용됨 / 410 만료 |

- 이미 멤버이면 역할을 **낮추지 않는다**. 초대 역할이 더 높으면 그 역할로 올린다.

### 가입 시 개인 워크스페이스 (PRD-0001 AC-2)

`POST /auth/signup`은 사용자 행과 같은 트랜잭션에서 개인 워크스페이스를 만들고 그 사용자를 owner로 넣는다. 둘 중 하나라도 실패하면 둘 다 만들어지지 않는다. 이름은 `displayName` 또는 이메일 로컬 파트이고, slug는 이메일 로컬 파트에서 만든다(겹치면 `-xxxx`를 붙인다). 개인 워크스페이스는 일반 워크스페이스와 같으며 삭제할 수도 있다.

## Schemas

```ts
type Role = "owner" | "admin" | "member" | "viewer";

interface Workspace { id: string; slug: string; name: string; createdAt: string; role: Role /* 호출자의 역할 */ }
interface Member { userId: string; email: string; displayName: string | null; role: Role; joinedAt: string }
interface Invite { id: string; email: string; role: Role; invitedBy: string | null; createdAt: string; expiresAt: string }
interface CreatedInvite extends Invite { token: string /* 이 응답에서만 */ }
```

- slug: `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`(소문자·숫자·하이픈, 3~40자, 하이픈으로 시작하거나 끝나지 않음). 전역에서 유일하다.
- 시각은 ISO-8601 UTC 문자열이다.

## Changelog

| Version | Date | Change |
|---------|------|--------|
| v0.1.0 | 2026-10-14 | TASK-0004 최초 작성 |
