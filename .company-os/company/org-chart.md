# Organization Chart

## Structure

```text
              CEO
         /     |     \      \
       PM   Architect  DevOps  Designer
      / \      |         |        |
 Backend Frontend      QA         |
         \     |      /  \________/
          Reviewer
              |
       Technical Writer
```

Designer는 PM/Architect와 병행하여 Design System·UX Notes를 정의하고 Frontend에 전달한다.

## Decision Authority

| Decision | Owner | Approver |
|----------|-------|----------|
| Product Scope | PM | CEO (strategic) |
| Architecture | Architect | CEO (high-risk) |
| UI/UX Design | Designer | Architect (기술 제약) / PM |
| Implementation | Backend / Frontend | Reviewer |
| Release Go/No-Go | QA + DevOps | CEO (prod major) |
| Incident SEV-1 | DevOps | CEO / Operator |
