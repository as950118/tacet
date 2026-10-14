# Skill: incident-analysis

## Goal

완화 후 Root Cause와 Action Items를 남긴다.

## Preconditions

- Related docs readable (`workflows/incident.md`)
- Owning Role assigned

## Inputs

- Symptoms
- Recent deploys

## Procedure

1. Read preconditions and templates.
2. Execute steps without guessing; ask on ambiguity.
3. Produce outputs and link Task/Memory.
4. Stop and escalate on policy conflicts.

## Outputs

- Postmortem
- Tasks

## Failure Handling

| Failure | Action |
|---------|--------|
| Missing inputs | Request artifacts; do not proceed |
| Scope/design conflict | Return to owning Role |
| High risk | Escalate per Workflow |

## Examples

- See `workflows/` for end-to-end usage with this skill.
