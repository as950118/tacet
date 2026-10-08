"""Register Tacet tools on a (Python) FastMCP server.

    from fastmcp import FastMCP
    from tacet.fastmcp import register_tools

    mcp = FastMCP("my-server")
    register_tools(mcp, frontend_dir="./frontend", backend_dir="./backend", prefix="tacet_")
"""

from __future__ import annotations

from typing import Any, Callable, Literal

from .client import Tacet

GraphMode = Literal["none", "mermaid", "json"]


def register_tools(mcp: Any, lens: Tacet | None = None, *, prefix: str = "", **lens_options: Any) -> list[str]:
    """
    Adds the Tacet tools to `mcp` (anything with FastMCP's `tool(fn, name=..., ...)`).

    Pass an existing `Tacet`, or its constructor options (index, frontend_dir, backend_dir, config, command, ...).
    Returns the registered tool names.
    """
    lens = lens or Tacet(**lens_options)

    def index_frontend(files: list[str] | None = None, changed_since: str | None = None) -> dict[str, Any]:
        """Analyze the TypeScript frontend and update the Tacet index. Pass `files` (or `changed_since`, a git ref)
        after editing code to get the APIs those files use; only changed index records are rewritten."""
        return lens.index_frontend(files=files, changed_since=changed_since)

    def extract_backend() -> dict[str, Any]:
        """Extract endpoints and DTOs from the Spring Boot backend sources into the index (requires Java 17+)."""
        return lens.extract_backend()

    def check_contract(files: list[str] | None = None, changed_since: str | None = None) -> dict[str, Any]:
        """Verify frontend API usage against the real backend contract: endpoint exists for the method, response
        fields read by the frontend exist (with typo suggestions), array/object shape, request body and query keys.
        Limit to changed code with `files` or `changed_since`. Returns PASS/WARNING/FAIL with file:line evidence."""
        return lens.check(files=files, changed_since=changed_since)

    def analyze_api_changes(save: bool = False, format: Literal["json", "markdown"] = "json") -> Any:
        """Diff the backend contract stored in the index with the backend sources now, and list every frontend
        location affected by each breaking change (DEFINITE / LIKELY / POSSIBLE). `save` makes it the new baseline."""
        return lens.analyze(save=save, format=format)

    def diff_api_changes(base: str, head: str | None = None, format: Literal["json", "markdown"] = "json") -> Any:
        """Compare the backend API at two git refs (head omitted = working tree) and list affected frontend code."""
        return lens.diff(base, head, format=format)

    def verify_api_changes(
        base: str | None = None,
        head: str | None = None,
        model: str | None = None,
        format: Literal["json", "markdown"] = "json",
    ) -> Any:
        """Backend change analysis plus AI review of only the findings static analysis could not decide
        (LIKELY / POSSIBLE). DEFINITE findings are never overridden; verdicts without evidence from the provided code
        become UNKNOWN. Compares against the stored contract, or between git refs with `base`/`head`."""
        return lens.verify(base=base, head=head, model=model, format=format)

    def impact_of_api(api: str, graph: GraphMode = "none") -> list[dict[str, Any]]:
        """Everything in the frontend that depends on an API (e.g. "GET /users/{id}"), without changing anything:
        call sites, response fields read and where, files and components."""
        return lens.impact_of_api(api, graph=graph)

    def impact_of_file(file: str, graph: GraphMode = "none") -> dict[str, Any]:
        """What a change to this frontend file can affect: APIs it calls or reads, API client functions defined in it
        and their callers, files importing it, and the blast radius."""
        return lens.impact_of_file(file, graph=graph)

    def impact_of_field(field: str, graph: GraphMode = "none") -> list[dict[str, Any]]:
        """Every endpoint that returns a DTO field (e.g. "UserResponse.name") and every frontend location reading it."""
        return lens.impact_of_field(field, graph=graph)

    def search(query: str) -> list[dict[str, Any]]:
        """Search APIs, frontend files, functions, components, DTOs and fields."""
        return lens.search(query)

    def impact_summary() -> dict[str, Any]:
        """Rank APIs by frontend files/components using them, files by APIs used, and list unused backend endpoints."""
        return lens.summary()

    def render_graph(
        format: Literal["mermaid", "html"] = "mermaid",
        api: str | None = None,
        file: str | None = None,
        field: str | None = None,
        out_path: str | None = None,
    ) -> str:
        """Render the API → field → function/component → file graph for the project or one api/file/field.
        "mermaid" returns flowchart text; "html" writes an interactive page and returns its path."""
        return lens.render_graph(format, api=api, file=file, field=field, out=out_path)

    def page_apis(page: str | None = None, api: str | None = None) -> list[dict[str, Any]]:
        """Which page uses which API. For each page (React Router / Next.js / Remix routes, `routes` in
        tacet.config.json, or components in pages/ views/ screens/): the APIs it requests or shows, the
        component → function chain, and the response fields read. Filter with `page` or `api` (substring);
        with `api` the rows are grouped by API."""
        return lens.page_apis(page=page, api=api)

    def relations(
        page: str | None = None,
        api: str | None = None,
        subject: str | None = None,
        predicate: str | None = None,
        object: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """Relations stored in the index database: `page` → its APIs, `api` → its pages (with call path and fields
        read), or relations by `subject` / `predicate` / `object` (showsComponent, renders, calls, requests, reads,
        handledBy, accepts, returns, hasField, typedAs, definedIn, usesApi). Entities by id or exact label."""
        return lens.relations(page=page, api=api, subject=subject, predicate=predicate, object=object, limit=limit)

    def ontology(
        focus: str | None = None,
        depth: int = 2,
        format: Literal["json", "mermaid", "turtle"] = "json",
        include_files: bool = False,
    ) -> Any:
        """The project as typed entities (Page, Component, Hook, ApiClient, Function, Endpoint, Controller, Dto,
        DtoField, Enum, File) and subject–predicate–object triples (showsComponent, renders, calls, requests, reads,
        usesApi [inferred], handledBy, accepts, returns, hasField, typedAs, definedIn) with file:line evidence.
        `focus` limits it to the neighborhood of an entity; "turtle" is RDF/OWL for triple stores and SPARQL."""
        return lens.ontology(focus=focus, depth=depth, format=format, include_files=include_files)

    tools: list[tuple[Callable[..., Any], bool]] = [
        (index_frontend, False),
        (extract_backend, False),
        (check_contract, True),
        (analyze_api_changes, False),
        (diff_api_changes, True),
        (verify_api_changes, True),
        (impact_of_api, True),
        (impact_of_file, True),
        (impact_of_field, True),
        (search, True),
        (impact_summary, True),
        (render_graph, False),
        (page_apis, True),
        (relations, True),
        (ontology, True),
    ]
    names = []
    for fn, read_only in tools:
        name = f"{prefix}{fn.__name__}"
        mcp.tool(fn, name=name, annotations={"readOnlyHint": read_only, "openWorldHint": False})
        names.append(name)
    return names
