# Skill: write-prd

## Goal

PRD를 모호함 없이 작성한다.

## Preconditions

- Related docs readable (`docs/prd-template.md`)
- Owning Role assigned

## Inputs

- Priority/request
- Project Memory

## Procedure

1. Read preconditions and templates.
2. Execute steps without guessing; ask on ambiguity.
3. Produce outputs and link Task/Memory.
4. Stop and escalate on policy conflicts.

## Outputs

- PRD
- Design Request

## Failure Handling

| Failure | Action |
|---------|--------|
| Missing inputs | Request artifacts; do not proceed |
| Scope/design conflict | Return to owning Role |
| High risk | Escalate per Workflow |

## Examples

- See `workflows/` for end-to-end usage with this skill.
