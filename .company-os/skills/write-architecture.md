# Skill: write-architecture

## Goal

승인된 PRD를 구현 가능한 Architecture Doc으로 변환한다.

## Preconditions

- Related docs readable (`docs/architecture-template.md`)
- Owning Role assigned
- PRD Approved

## Inputs

- Approved PRD
- `company/tech-stack.md`
- decision-memory

## Procedure

1. Read preconditions and templates.
2. Execute steps without guessing; ask on ambiguity.
3. Produce outputs and link Task/Memory.
4. Stop and escalate on policy conflicts.

## Outputs

- Architecture Doc
- ADR(s) for notable decisions (`skills/write-adr`)
- Design Pack for Backend/Frontend handoff

## Failure Handling

| Failure | Action |
|---------|--------|
| Missing inputs | Request artifacts; do not proceed |
| Scope/design conflict | Return to owning Role |
| High risk | Escalate per Workflow |

## Examples

- See `workflows/` for end-to-end usage with this skill.
