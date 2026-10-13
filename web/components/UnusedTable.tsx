"use client";

import { useMemo, useState } from "react";

export interface EndpointRow {
  usage: "frontend" | "service" | "client-declared" | "unused";
  method: string;
  path: string;
  controller: string;
  handler: string;
  file: string;
  line: number;
  otherMethodsUsed: string[];
  routes: string[] | null;
  callers: number;
}

const USAGE_LABEL: Record<EndpointRow["usage"], string> = {
  unused: "미사용",
  "client-declared": "client 선언만",
  service: "service",
  frontend: "frontend",
};

type Scope = "not-used" | "unused" | "all";
type SortKey = "path" | "method" | "controller" | "usage";

const segmentsOf = (path: string) => path.replace(/^\/+|\/+$/g, "").split("/");

/** Every API of the backend with who uses it; filters by path segment and exports what is shown as CSV. */
export function UnusedTable({ project, rows }: { project: string; rows: EndpointRow[] }) {
  const [scope, setScope] = useState<Scope>("not-used");
  const [query, setQuery] = useState("");
  const [method, setMethod] = useState("");
  const [segments, setSegments] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "path", desc: false });

  const inScope = useMemo(
    () =>
      rows.filter((r) =>
        scope === "all" ? true : scope === "unused" ? r.usage === "unused" : r.usage === "unused" || r.usage === "client-declared",
      ),
    [rows, scope],
  );

  /** One select per path level; each lists the values left after the levels before it. */
  const levels = useMemo(() => {
    const out: Array<{ values: Array<[string, number]> }> = [];
    let remaining = inScope;
    for (let i = 0; i < 12; i++) {
      const counts = new Map<string, number>();
      for (const r of remaining) {
        const seg = segmentsOf(r.path)[i];
        if (seg !== undefined) counts.set(seg, (counts.get(seg) ?? 0) + 1);
      }
      if (!counts.size) break;
      out.push({ values: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) });
      if (!segments[i]) break;
      remaining = remaining.filter((r) => segmentsOf(r.path)[i] === segments[i]);
    }
    return out;
  }, [inScope, segments]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = inScope.filter((r) => {
      if (method && r.method !== method) return false;
      const segs = segmentsOf(r.path);
      if (segments.some((s, i) => s && segs[i] !== s)) return false;
      return !q || `${r.method} ${r.path} ${r.controller} ${r.handler} ${r.file}`.toLowerCase().includes(q);
    });
    const dir = sort.desc ? -1 : 1;
    return filtered.sort((a, b) => dir * String(a[sort.key]).localeCompare(String(b[sort.key])) || a.path.localeCompare(b.path));
  }, [inScope, query, method, segments, sort]);

  const setSegment = (i: number, value: string) => setSegments([...segments.slice(0, i), value]);
  const sortBy = (key: SortKey) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.desc ? " ↓" : " ↑") : "");

  const downloadCsv = () => {
    const depth = Math.max(0, ...shown.map((r) => segmentsOf(r.path).length));
    const segCols = Array.from({ length: depth }, (_, i) => `path_${i + 1}`);
    const header = ["usage", "method", "path", ...segCols, "controller", "handler", "other_methods_used", "gateway_routes", "file", "line"];
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = shown.map((r) => {
      const segs = segmentsOf(r.path);
      return [
        r.usage,
        r.method,
        r.path,
        ...segCols.map((_, i) => segs[i] ?? ""),
        r.controller,
        r.handler,
        r.otherMethodsUsed.join(" "),
        r.routes?.join(" ") ?? "",
        r.file,
        r.line,
      ]
        .map(cell)
        .join(",");
    });
    // BOM so Excel opens the UTF-8 file correctly.
    const blob = new Blob(["﻿" + [header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${project}-apis${segments.filter(Boolean).length ? "-" + segments.filter(Boolean).join("-") : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const methods = [...new Set(inScope.map((r) => r.method))].sort();

  return (
    <>
      <div className="filters">
        <select value={scope} onChange={(e) => { setScope(e.target.value as Scope); setSegments([]); }}>
          <option value="not-used">미사용 + client 선언만</option>
          <option value="unused">미사용만</option>
          <option value="all">전체 endpoint</option>
        </select>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">모든 method</option>
          {methods.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input type="search" placeholder="path, controller, handler, file 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={downloadCsv}>CSV 다운로드 ({shown.length})</button>
      </div>
      <div className="filters">
        <span className="muted">path</span>
        {levels.map((level, i) => (
          <select key={i} value={segments[i] ?? ""} onChange={(e) => setSegment(i, e.target.value)}>
            <option value="">{`path_${i + 1}: 전체`}</option>
            {level.values.map(([v, n]) => (
              <option key={v} value={v}>
                {v} ({n})
              </option>
            ))}
          </select>
        ))}
        {segments.some(Boolean) && <button onClick={() => setSegments([])}>초기화</button>}
      </div>
      <p className="muted">
        {shown.length.toLocaleString()} / {inScope.length.toLocaleString()}개
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th onClick={() => sortBy("usage")}>사용{arrow("usage")}</th>
              <th onClick={() => sortBy("method")}>method{arrow("method")}</th>
              <th onClick={() => sortBy("path")}>path{arrow("path")}</th>
              <th onClick={() => sortBy("controller")}>controller{arrow("controller")}</th>
              <th>비고</th>
              <th>위치</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 1000).map((r) => (
              <tr key={`${r.method} ${r.path} ${r.handler}`}>
                <td>
                  <span className={`badge ${r.usage}`}>{USAGE_LABEL[r.usage]}</span>
                  {r.callers > 0 && <span className="muted"> {r.callers}</span>}
                </td>
                <td className="mono">{r.method}</td>
                <td className="mono">{r.path}</td>
                <td>
                  {r.controller}
                  <div className="muted mono">{r.handler}</div>
                </td>
                <td>
                  {r.otherMethodsUsed.length > 0 && <div>같은 path의 {r.otherMethodsUsed.join(", ")}는 사용 중</div>}
                  {r.routes !== null && r.routes.length === 0 && <div className="muted">gateway route 없음</div>}
                </td>
                <td className="mono muted">
                  {r.file}:{r.line}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > 1000 && <p className="muted">처음 1,000개만 표시합니다. 전체는 CSV로 받으세요.</p>}
    </>
  );
}
