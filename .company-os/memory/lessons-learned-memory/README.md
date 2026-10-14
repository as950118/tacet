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
