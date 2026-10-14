# Runtime Stub

Minimal placeholders for LangChain / LangGraph / LangSmith.

## Setup

```bash
cd runtime
uv sync            # or: pip install langchain langgraph langsmith python-dotenv
cp .env.example .env
# add OPENROUTER_API_KEY / LANGSMITH_API_KEY as needed
```

Wire real graphs by copying patterns from the source kit’s full `runtime/` (if available in the parent monorepo), or implement:

- `company_os/config.py` — env + LangSmith enable
- `company_os/state.py` — FeatureState
- `company_os/feature_graph.py` — StateGraph

## Principle

Agents load prompts from `../roles` and `../agents`, not from hardcoded guesses.
