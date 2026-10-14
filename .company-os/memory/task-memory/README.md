# Task Memory

| Task ID | Title | Status | Path |
|---------|-------|--------|------|
| TASK-0002 | platform 스키마와 마이그레이션 러너 | QA (REVIEW-0001 approved) | `../../tasks/TASK-0002.md` |
| TASK-0003 | API: 자체 인증(가입·로그인·세션)과 Principal | QA (REVIEW-0001 approved) | `../../tasks/TASK-0003.md` |

Append short event logs; keep details in `tasks/`.

## Log

- 2026-10-14 TASK-0001 Done: ADR-0002 Accepted (self-built auth, public sign-up).
- 2026-10-14 TASK-0002 / TASK-0003 In Review: implementation in `965b9df`, `bcb1365`.
- 2026-10-14 REVIEW-0001: `/security-review` found no HIGH/MEDIUM issues. Reviewer recommends Approve with follow-ups (Major R1 docs, Minor R2 expired-session cleanup, Minor R3 auth event logging). Gate waits for human approval (no self-approve). → `projects/apilens-platform/reviews/REVIEW-0001-accounts-auth.md`
- 2026-10-14 REVIEW-0001 Approved by heonjinjeong. R1 (docs) and R2 (expired-session purge) resolved; TASK-0002 / TASK-0003 → QA. R3 deferred to TASK-0008.
- 2026-10-14 QA-0001 Sign-off: TASK-0002 / TASK-0003 → Done (35 black-box scenarios on SQLite/PostgreSQL, 0 bugs; 7 HTTP tests added to `server-accounts.test.ts`). Out-of-scope notes O1 (concurrent first CREATE SCHEMA on PG) and O2 (`NODE_OPTIONS` to avoid the heap relaunch child) handed to DevOps for TASK-0008. → `projects/apilens-platform/qa/QA-0001-accounts-auth.md`
- 2026-10-14 REVIEW-0002 (TASK-0004, `d6687e9`): no HIGH/MEDIUM security issue at ≥80% confidence. Reviewer recommends Approve with follow-ups (Major R1: an invite outlives its inviter's removal/demotion, fix before QA; Minor R2–R6). Tests 247 pass (SQLite), 296 with PostgreSQL. OQ-1/2/5 to PM. Gate waits for human approval (no self-approve). → `projects/apilens-platform/reviews/REVIEW-0002-workspaces.md`
- 2026-10-14 REVIEW-0002 Approved by heonjinjeong. Decisions: keep admin-cannot-grant-admin; users with no workspace can create one (`/me` exposes it); renamed slugs keep aliases with 308 redirects; expired invites purged hourly. R1–R5 + decisions → TASK-0004 follow-up; R6 + index cleanup → TASK-0005 AC.
- 2026-10-14 TASK-0004 REVIEW-0002 follow-ups done → QA: invites die with the inviter's authority (cleanup on remove/demote/leave/transfer + re-check at accept, 404), revoke/replace need `mayGrant`, accept locked per workspace, slug races retried/409, self-transfer 400, `/me.workspaces`, hourly expired-invite purge, migration 2 slug aliases with 308 redirects (members only). Tests 264 / 330 with PG. R6 → TASK-0005, N3 → TASK-0008.
- 2026-10-14 QA-0002 Sign-off: TASK-0004 → Done (55 black-box scenarios / 302 checks on real servers, SQLite and PostgreSQL, 0 bugs; every REVIEW-0002 "Resolved" item verified incl. R1 inviter re-check, alias 308s, migration 1→2 upgrade at start). 7 HTTP tests added in `packages/cli/test/server-workspaces-qa.test.ts`; tests 271 / 344 with PG. Notes O1 (race loser gets 403/404, not 409), O3 (admin cannot self-demote), O4 (expired invites listed until purge) → TASK-0007. → `projects/apilens-platform/qa/QA-0002-workspaces.md`
