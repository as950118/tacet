# ReleaseGraph

Implements `workflows/release.md`.

## Nodes

preflight → check_approvals → deploy_staging → smoke → approve_production → deploy_production → verify → record  
↘ rollback / abort / escalate

## Approval Matrix

| Kind | Required |
|------|----------|
| Staging | DevOps + CI |
| Prod Minor | DevOps + QA |
| Prod Major | DevOps + QA + Architect + CEO |
| Emergency Hotfix | DevOps + CEO |
