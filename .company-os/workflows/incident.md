# Workflow: incident

## Trigger

Alert / user impact

## Participants

DevOps commander + mitigators

## Inputs

- Trigger payload
- Related Memory / prior docs

## Outputs

Timeline, Postmortem, Actions

## Approval Rules

| Gate | Approver |
|------|----------|
| Scope/Design ready | PM / Architect (+ CEO if strategic/high-risk) |
| Code ready | Reviewer |
| Quality ready | QA |
| Production | DevOps + workflow-specific rules |

## Escalation Rules

| Condition | Escalate To |
|-----------|-------------|
| Priority/scope conflict | CEO |
| Design feasibility | Architect → PM |
| SEV-1 / security | CEO + Operator |
| Approval deadlock | CEO |

## Completion Conditions

- [ ] Required artifacts produced
- [ ] Gates passed or waived with documented reason
- [ ] Memory updated when decision/lesson applies
- [ ] Tasks closed or deferred with owners
