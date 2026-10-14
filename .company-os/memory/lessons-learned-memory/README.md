# Lessons Learned Memory

## Template

```markdown
### LL-NNNN — Title
Date / Source / Type
Lesson:
Apply when:
Anti-pattern:
```

### LL-0001 — Docs before runtime

| Field | Value |
|-------|-------|
| Date | 2026-10-14 |
| Type | Success pattern |

**Lesson:** Fix Role/Workflow/Memory before coding graphs to reduce rework.

- 2026-10-14 (REL-0002): `gh pr merge` merged PR #10 with failing CI because `main` has no branch protection. Before merging, confirm every check passed. Turn on required checks for `main`.

### LL-0002 — Advisory lock keys must carry the data's scope

| Field | Value |
|-------|-------|
| Date | 2026-10-14 |
| Source | TASK-0011 |
| Type | Failure pattern |

**Lesson:** PostgreSQL advisory locks are database-wide, not per schema. A key without the schema made every schema in the database (each test's schema, another deployment) queue behind the others' migrations, and the wait has no limit; it showed up as a 10s hook timeout that looked like a sign-up deadlock.

**Apply when:** Adding a lock (advisory lock, file lock, mutex) that guards data living in a narrower scope than the lock itself; or reading a timeout: check which phase used the time (test duration 10006ms = setup, not teardown) before guessing.

**Anti-pattern:** `pg_advisory_xact_lock(hashtext('app:migrations'))` shared by all tenants/schemas; raising the hook timeout instead of finding the waiter.
