# Skill: release-service

## Goal

승인된 변경을 안전하게 배포한다.

## Preconditions

- Related docs readable (`workflows/release.md`)
- Owning Role assigned

## Inputs

- QA Sign-off
- Rollback plan

## Procedure

1. Read preconditions and templates.
2. Execute steps without guessing; ask on ambiguity.
3. Produce outputs and link Task/Memory.
4. Stop and escalate on policy conflicts.

## Outputs

- Deployment Record

## Failure Handling

| Failure | Action |
|---------|--------|
| Missing inputs | Request artifacts; do not proceed |
| Scope/design conflict | Return to owning Role |
| High risk | Escalate per Workflow |

## Examples

- See `workflows/` for end-to-end usage with this skill.
