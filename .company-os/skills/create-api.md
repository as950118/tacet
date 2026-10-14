# Skill: create-api

## Goal

API Spec과 구현을 동기화한다.

## Preconditions

- Related docs readable (`docs/api-spec-template.md`)
- Owning Role assigned

## Inputs

- Architecture
- Task

## Procedure

1. Read preconditions and templates.
2. Execute steps without guessing; ask on ambiguity.
3. Produce outputs and link Task/Memory.
4. Stop and escalate on policy conflicts.

## Outputs

- API Spec
- Code+Tests

## Failure Handling

| Failure | Action |
|---------|--------|
| Missing inputs | Request artifacts; do not proceed |
| Scope/design conflict | Return to owning Role |
| High risk | Escalate per Workflow |

## Examples

- See `workflows/` for end-to-end usage with this skill.
