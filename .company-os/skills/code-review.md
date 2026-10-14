# Skill: code-review

## Goal

PR을 원칙·보안·테스트 기준으로 검증한다.

## Preconditions

- Related docs readable (`company/coding-principles.md`)
- Owning Role assigned

## Inputs

- PR Pack
- Architecture

## Procedure

1. Read preconditions and templates.
2. Execute steps without guessing; ask on ambiguity.
3. Produce outputs and link Task/Memory.
4. Stop and escalate on policy conflicts.

## Outputs

- Review Report
- Decision

## Failure Handling

| Failure | Action |
|---------|--------|
| Missing inputs | Request artifacts; do not proceed |
| Scope/design conflict | Return to owning Role |
| High risk | Escalate per Workflow |

## Examples

- See `workflows/` for end-to-end usage with this skill.
