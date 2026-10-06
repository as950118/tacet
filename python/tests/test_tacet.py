import asyncio
import json
import sys

import pytest

from tacet import Tacet, TacetError
from conftest import requires_backend, requires_cli


@pytest.fixture
def lens(lens_options):
    return Tacet(**lens_options)


@requires_cli
def test_index_frontend_reports_summary(lens):
    result = lens.index_frontend()
    assert result["summary"]["apiCalls"] == 15
    assert result["scope"] is None


@requires_backend
class TestWithBackend:
    @pytest.fixture(autouse=True)
    def indexed(self, lens):
        lens.index_frontend()
        lens.extract_backend()

    def test_check_contract(self, lens):
        report = lens.check()
        assert report["result"] == "FAIL"
        assert report["counts"] == {"error": 5, "warning": 2, "info": 0}
        assert lens.check(files=["src/pages/Product.tsx"])["result"] == "PASS"

    def test_index_with_check_returns_both(self, lens):
        result = lens.index_frontend(files=["src/pages/UserAdmin.tsx"], check=True)
        assert result["scope"] == ["src/pages/UserAdmin.tsx"]
        assert result["check"]["result"] == "FAIL"

    def test_impact_queries(self, lens):
        [impact] = lens.impact_of_api("GET /users/{id}", graph="mermaid")
        assert len(impact["files"]) == 4
        assert "graph" not in impact
        assert impact["mermaid"].startswith("flowchart LR")

        assert lens.impact_of_file("src/api/user.ts")["dependents"] == [
            "src/pages/User.tsx",
            "src/pages/UserAdmin.tsx",
            "src/pages/UserList.tsx",
        ]
        assert lens.impact_of_field("UserResponse.name")[0]["dtoId"] == "com.example.user.UserResponse"
        assert any(hit["label"] == "UserCard" for hit in lens.search("UserCard"))
        assert "GET /users/summary" in lens.summary()["unusedEndpoints"]

    def test_backend_changes(self, lens, lens_options):
        report = lens.analyze(lens_options["backend_dir"].parent / "backend-v2")
        assert report["result"] == "FAIL"
        assert report["counts"]["DEFINITE"] == 9
        markdown = lens.analyze(lens_options["backend_dir"].parent / "backend-v2", format="markdown")
        assert markdown.startswith("## Tacet: backend API change report: FAIL")

    def test_render_graph(self, lens, tmp_path):
        assert lens.render_graph(api="GET /products/{id}").startswith("flowchart LR")
        path = lens.render_graph("html", out=tmp_path / "graph.html")
        assert "<title>Tacet impact graph</title>" in open(path, encoding="utf-8").read()

    def test_ontology(self, lens):
        pages = lens.page_apis()
        assert {p["component"] for p in pages} == {"UserPage", "UserList"}
        by_api = lens.page_apis(api="GET /users/{id}")
        assert [p["component"] for p in by_api[0]["pages"]] == ["UserPage"]
        assert lens.ontology(focus="UserCard", format="turtle").startswith("@prefix tacet:")
        ontology = lens.ontology(include_files=False)
        assert not any(e["class"] == "File" for e in ontology["entities"])

    def test_fastmcp_tools(self, lens):
        fastmcp = pytest.importorskip("fastmcp")
        from tacet.fastmcp import register_tools

        mcp = fastmcp.FastMCP("host")

        @mcp.tool
        def host_tool() -> str:
            return "ok"

        names = register_tools(mcp, lens, prefix="tacet_")
        assert len(names) == 14

        async def run():
            async with fastmcp.Client(mcp) as client:
                tools = {t.name: t for t in await client.list_tools()}
                assert set(tools) == {"host_tool", *names}
                annotations = tools["tacet_check_contract"].annotations
                assert getattr(annotations, "read_only_hint", None) is True or annotations.readOnlyHint is True
                result = await client.call_tool("tacet_check_contract", {"files": ["src/pages/Product.tsx"]})
                return json.loads(result.content[0].text)

        assert asyncio.run(run())["result"] == "PASS"


@requires_cli
def test_cli_errors_become_exceptions(tmp_path):
    with pytest.raises(TacetError, match="No frontend index"):
        Tacet(index=tmp_path / "empty.db").summary()


def test_missing_directory_is_reported(tmp_path):
    with pytest.raises(TacetError, match="frontend_dir"):
        Tacet(index=tmp_path / "x.db").index_frontend()


def test_missing_cli_is_reported(tmp_path, monkeypatch):
    monkeypatch.delenv("TACET_CLI")
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(TacetError, match="CLI not found"):
        Tacet(index=tmp_path / "x.db").summary()


def test_falls_back_to_the_matching_npm_release(tmp_path, monkeypatch):
    import tacet
    from tacet import client

    monkeypatch.delenv("TACET_CLI")
    monkeypatch.setattr(client.shutil, "which", lambda name: "/usr/bin/npx" if name == "npx" else None)
    assert client._default_command() == ["/usr/bin/npx", "--yes", f"@tacet-api/cli@{tacet.__version__}"]


def test_verify_builds_the_cli_call(tmp_path):
    fake = tmp_path / "fake_cli.py"
    fake.write_text("import json, sys\nprint(json.dumps({'argv': sys.argv[1:]}))\n")
    lens = Tacet(index=tmp_path / "i.db", backend_dir="be", command=[sys.executable, str(fake)])
    argv = lens.verify(base="origin/main", model="claude-opus-5", effort="low")["argv"]
    assert argv[:3] == ["--index", str(tmp_path / "i.db"), "verify"]
    assert argv[3:] == [
        "--backend", "be", "--fail-on", "never", "--base", "origin/main",
        "--model", "claude-opus-5", "--effort", "low", "--format", "json",
    ]
