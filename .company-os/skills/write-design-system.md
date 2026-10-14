# Skill: write-design-system

## Goal

승인된 PRD와 Architecture 경계에 맞는 Design System과 UX Notes를 작성한다.

## Preconditions

- Related docs readable (`docs/design-system-template.md`)
- Owning Role assigned
- PRD Approved

## Inputs

- Approved PRD
- Architecture (API/Domain boundary)
- `company/tech-stack.md`
- decision-memory

## Procedure

1. Read preconditions and templates.
2. Execute steps without guessing; ask on ambiguity.
3. Produce outputs and link Task/Memory.
4. Stop and escalate on policy conflicts.

## Outputs

- Design System Doc
- UX Notes for Frontend handoff

## Failure Handling

| Failure | Action |
|---------|--------|
| Missing inputs | Request artifacts; do not proceed |
| Scope/design conflict | Return to owning Role |
| High risk | Escalate per Workflow |

## Examples

- See `workflows/` for end-to-end usage with this skill.
