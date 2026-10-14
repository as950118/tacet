# FeatureGraph

Implements `workflows/create-feature.md` for ApiLens Platform.

## State (sketch)

```text
run_id, feature_request, prd_path, architecture_path, adr_paths[],
review_decision, qa_decision, status, escalation, messages[]
```

## Nodes

intake → write_prd → design → implement → review ⇄ fix → qa → finalize  
↘ clarify / escalate (CEO) as needed

## Gates

PRD ready → Design ready → Reviewer Approve → QA Sign-off → (optional Release)
