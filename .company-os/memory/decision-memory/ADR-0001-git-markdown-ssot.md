# ADR-0001: Git-Markdown Company OS as SSOT

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-10-14 |
| Deciders | Architect, CEO |
| Product | ApiLens Platform |

## Context

Multi-Agent systems without shared docs create hallucination and un-auditable work.

## Decision

All company knowledge (Role, Skill, Workflow, Memory) lives as Markdown in Git.

## Consequences

### Positive
- Shared grounding, reviewable diffs, easier onboarding

### Negative
- Requires documentation discipline

## Rejected Alternatives

| Option | Why Rejected |
|--------|--------------|
| Wiki-only outside git | Drift from code/agents |
| Prompt-only memory | Non-durable, non-auditable |
