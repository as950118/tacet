"""Thin Python client over the Tacet CLI's JSON output."""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Sequence

from ._version import __version__

GraphMode = Literal["none", "mermaid", "json"]


class TacetError(RuntimeError):
    """The Tacet CLI failed or could not be found."""


def _default_command() -> list[str]:
    """$TACET_CLI, then `tacet` on PATH, then the matching npm release through npx."""
    configured = os.environ.get("TACET_CLI")
    if configured:
        return shlex.split(configured)
    found = shutil.which("tacet")
    if found:
        return [found]
    npx = shutil.which("npx")
    if npx:
        return [npx, "--yes", f"@api-tacet/cli@{__version__}"]
    raise TacetError(
        "Tacet CLI not found. Install Node.js 22.13+ (the CLI then runs through npx), "
        "`npm install -g @api-tacet/cli`, or set TACET_CLI, "
        'e.g. TACET_CLI="node /path/to/tacet/packages/cli/dist/bin.js".'
    )


@dataclass
class Tacet:
    """
    Every method returns the same JSON-compatible structures as the TypeScript API.

    Requires Node.js 22.13+ (and Java 17+ for `extract_backend`) where the CLI runs.
    """

    index: str | os.PathLike[str] = ".tacet/index.db"
    frontend_dir: str | os.PathLike[str] | None = None
    backend_dir: str | os.PathLike[str] | None = None
    config: str | os.PathLike[str] | None = None
    command: Sequence[str] | None = None
    """How to invoke the CLI. Defaults to $TACET_CLI, then `tacet` on PATH."""
    cwd: str | os.PathLike[str] | None = None
    timeout: float | None = 600
    env: dict[str, str] = field(default_factory=dict)

    # ------------------------------------------------------------------ index

    def index_frontend(
        self,
        frontend_dir: str | os.PathLike[str] | None = None,
        *,
        files: Sequence[str] | None = None,
        changed_since: str | None = None,
        check: bool = False,
    ) -> dict[str, Any]:
        """Analyze the frontend and update the index. With `files`/`changed_since`, also list the APIs they use."""
        args = ["index", self._dir(frontend_dir, self.frontend_dir, "frontend_dir"), "--format", "json"]
        args += self._scope(files, changed_since)
        if check:
            args += ["--check", "--fail-on", "never"]
        return self._run(args)

    def extract_backend(self, backend_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
        """Extract the Spring Boot API contract (endpoints, DTOs) into the index."""
        return self._run(["extract-backend", self._dir(backend_dir, self.backend_dir, "backend_dir"), "--format", "json"])

    # ------------------------------------------------------------------ API changes

    def analyze(
        self,
        backend_dir: str | os.PathLike[str] | None = None,
        *,
        save: bool = False,
        format: Literal["json", "markdown"] = "json",
    ) -> Any:
        """Diff the stored backend contract against `backend_dir` now and grade the affected frontend code."""
        args = ["analyze", "--backend", self._dir(backend_dir, self.backend_dir, "backend_dir"), "--fail-on", "never"]
        if save:
            args.append("--save")
        return self._report(args, format)

    def diff(
        self,
        base: str,
        head: str | None = None,
        *,
        backend_dir: str | os.PathLike[str] | None = None,
        format: Literal["json", "markdown"] = "json",
    ) -> Any:
        """Backend API changes between two git refs (head omitted = working tree) and the frontend code they affect."""
        args = ["diff", "--base", base, "--backend", self._dir(backend_dir, self.backend_dir, "backend_dir"), "--fail-on", "never"]
        if head:
            args += ["--head", head]
        return self._report(args, format)

    def verify(
        self,
        backend_dir: str | os.PathLike[str] | None = None,
        *,
        base: str | None = None,
        head: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None,
        format: Literal["json", "markdown"] = "json",
    ) -> Any:
        """Change analysis plus AI verification of the undecided (LIKELY/POSSIBLE) findings.

        Compares against the stored contract, or between git refs when `base` is given.
        Needs AI credentials where the CLI runs (e.g. ANTHROPIC_API_KEY)."""
        args = ["verify", "--backend", self._dir(backend_dir, self.backend_dir, "backend_dir"), "--fail-on", "never"]
        for flag, value in (("--base", base), ("--head", head), ("--provider", provider), ("--model", model), ("--effort", effort)):
            if value:
                args += [flag, value]
        return self._report(args, format)

    def _report(self, args: list[str], format: str) -> Any:
        if format == "markdown":
            return self._run_text([*args, "--format", "markdown"])
        return self._run([*args, "--format", "json"])

    # ------------------------------------------------------------------ queries

    def check(self, *, files: Sequence[str] | None = None, changed_since: str | None = None) -> dict[str, Any]:
        """Check frontend API usage against the backend contract. `result` is PASS, WARNING or FAIL."""
        return self._run(["check", "--format", "json", "--fail-on", "never", *self._scope(files, changed_since)])

    def impact_of_api(self, api: str, *, graph: GraphMode = "none") -> list[dict[str, Any]]:
        """Frontend call sites, field reads, files and components depending on an API, e.g. "GET /users/{id}"."""
        return self._run(["impact", "--api", api, "--format", "json", "--graph", graph])

    def impact_of_file(self, file: str, *, graph: GraphMode = "none") -> dict[str, Any]:
        """What changing a frontend file can affect: its APIs, client functions and their callers, importers."""
        return self._run(["impact", "--file", file, "--format", "json", "--graph", graph])

    def impact_of_field(self, field: str, *, graph: GraphMode = "none") -> list[dict[str, Any]]:
        """Every endpoint returning a DTO field (e.g. "UserResponse.name") and every frontend read of it."""
        return self._run(["impact", "--field", field, "--format", "json", "--graph", graph])

    def search(self, query: str) -> list[dict[str, Any]]:
        """Search APIs, files, functions, components, DTOs and fields."""
        return self._run(["impact", "--search", query, "--format", "json"])

    def summary(self) -> dict[str, Any]:
        """APIs and files ranked by impact, plus backend endpoints no frontend code calls."""
        return self._run(["impact", "--summary", "--format", "json"])

    def render_graph(
        self,
        format: Literal["mermaid", "html"] = "mermaid",
        *,
        api: str | None = None,
        file: str | None = None,
        field: str | None = None,
        out: str | os.PathLike[str] | None = None,
    ) -> str:
        """Mermaid text, or the path of a written interactive HTML page."""
        target = [("--api", api), ("--file", file), ("--field", field)]
        selected = [arg for pair in target if pair[1] for arg in pair]
        if format == "html":
            path = Path(out or ".tacet/graph.html").expanduser()
            if not path.is_absolute():
                path = Path(self.cwd or os.getcwd()) / path
            base = ["impact", *selected, "--format", "html"] if selected else ["graph", "--format", "html"]
            self._run_text([*base, "-o", str(path)])
            return str(path.resolve())
        if selected:
            return self._run_text(["impact", *selected, "--format", "mermaid"])
        return self._run_text(["graph", "--format", "mermaid"])

    # ------------------------------------------------------------------ internals

    def _base(self) -> list[str]:
        command = list(self.command) if self.command else _default_command()
        base = [*command, "--index", os.fspath(self.index)]
        if self.config:
            base += ["--config", os.fspath(self.config)]
        return base

    def _exec(self, args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        try:
            result = subprocess.run(
                [*self._base(), *args],
                capture_output=True,
                text=True,
                cwd=self.cwd,
                timeout=self.timeout,
                env={**os.environ, **self.env},
                check=False,
            )
        except FileNotFoundError as err:
            raise TacetError(f"Could not start the Tacet CLI: {err}") from err
        if result.returncode != 0:
            message = (result.stderr or result.stdout).strip() or f"exit code {result.returncode}"
            raise TacetError(message)
        return result

    def _run(self, args: Sequence[str]) -> Any:
        output = self._exec(args).stdout
        try:
            return json.loads(output)
        except json.JSONDecodeError as err:
            raise TacetError(f"Tacet CLI did not return JSON: {output[:200]}") from err

    def _run_text(self, args: Sequence[str]) -> str:
        return self._exec(args).stdout.rstrip("\n")

    @staticmethod
    def _scope(files: Sequence[str] | None, changed_since: str | None) -> list[str]:
        if changed_since:
            return ["--changed-since", changed_since]
        if files:
            return ["--files", *files]
        return []

    @staticmethod
    def _dir(value: str | os.PathLike[str] | None, default: str | os.PathLike[str] | None, name: str) -> str:
        chosen = value or default
        if not chosen:
            raise TacetError(f"`{name}` is required (no default was configured)")
        return os.fspath(chosen)
