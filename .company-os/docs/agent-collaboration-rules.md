# Agent Collaboration Rules

## Canonical Pipeline

```text
PM → Architect → Backend → Reviewer → QA → Release(DevOps)
```

Frontend는 API Outline 이후 Backend와 병렬 가능.
Designer는 PM 직후 Architect와 병행 진행 가능하며, 산출물은 Frontend 구현 전 확정되어야 한다.

## Stage Contracts

| Stage | Actor | Input | Output |
|-------|-------|-------|--------|
| Scope | PM | Request | PRD, Design Request |
| Design | Architect | PRD | Architecture, ADR, Design Pack |
| Design(UX) | Designer | PRD, Architecture | Design System, UX Notes |
| Implement | Backend/FE | Design Pack | Code, Tests, Spec, PR |
| Review | Reviewer | PR Pack | Approve / Changes / Block |
| QA | QA | Approved build | Sign-off or Bugs |
| Release | DevOps | Sign-off | Deployment Record |

## Rules

1. No skipping gates without emergency path
2. No silent scope/architecture change
3. Handoff without artifact = invalid
4. Questions over guesses
5. Memory write-back on decisions/incidents
6. No self-approve
