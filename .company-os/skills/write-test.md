# Skill: write-test

## Goal

회귀를 막는 자동 테스트를 작성한다.

## Preconditions

- Related docs readable (`AC/Bug`)
- Owning Role assigned

## Inputs

- Behavior under test

## Procedure

1. Read preconditions and templates.
2. Execute steps without guessing; ask on ambiguity.
3. Produce outputs and link Task/Memory.
4. Stop and escalate on policy conflicts.

## Outputs

- Tests
- Evidence

## Failure Handling

| Failure | Action |
|---------|--------|
| Missing inputs | Request artifacts; do not proceed |
| Scope/design conflict | Return to owning Role |
| High risk | Escalate per Workflow |

## Examples

- See `workflows/` for end-to-end usage with this skill.
