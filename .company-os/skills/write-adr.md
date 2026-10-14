# Skill: write-adr

## Goal

기술 결정을 ADR로 고정한다.

## Preconditions

- Related docs readable (`docs/adr-template.md`)
- Owning Role assigned

## Inputs

- Context/options
- decision-memory

## Procedure

1. Read preconditions and templates.
2. Execute steps without guessing; ask on ambiguity.
3. Produce outputs and link Task/Memory.
4. Stop and escalate on policy conflicts.

## Outputs

- ADR
- Index update

## Failure Handling

| Failure | Action |
|---------|--------|
| Missing inputs | Request artifacts; do not proceed |
| Scope/design conflict | Return to owning Role |
| High risk | Escalate per Workflow |

## Examples

- See `workflows/` for end-to-end usage with this skill.
