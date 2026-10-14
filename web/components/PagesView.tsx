"use client";

import { useMemo, useState } from "react";

export interface PageRow {
  page: string;
  route: string | null;
  component: string;
  file: string;
  apis: Array<{ api: string; fields: number; common: boolean; status?: string }>;
}

/** Each page and the APIs it calls (directly or through the components it renders). */
export function PagesView({ project, pages }: { project: string; pages: PageRow[] }) {
  const [query, setQuery] = useState("");
  const [hideCommon, setHideCommon] = useState(true);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pages
      .map((p) => ({ ...p, apis: hideCommon ? p.apis.filter((a) => !a.common) : p.apis }))
      .filter(
        (p) =>
          !q ||
          `${p.route ?? ""} ${p.component} ${p.file}`.toLowerCase().includes(q) ||
          p.apis.some((a) => a.api.toLowerCase().includes(q)),
      )
      .sort((a, b) => (a.route ?? a.component).localeCompare(b.route ?? b.component));
  }, [pages, query, hideCommon]);

  const ontologyHref = (p: PageRow) =>
    `/api/tacet/projects/${encodeURIComponent(project)}/ontology?format=html&focus=${encodeURIComponent(p.component)}`;

  return (
    <>
      <div className="filters">
        <input type="search" placeholder="route, component, API 검색 (예: GET /admin/v1/inventory)" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label>
          <input type="checkbox" checked={hideCommon} onChange={(e) => setHideCommon(e.target.checked)} /> 공통 API 숨기기
        </label>
        <span className="muted">
          {shown.length.toLocaleString()} / {pages.length.toLocaleString()} 페이지
        </span>
      </div>
      {shown.slice(0, 300).map((p) => (
        <details key={p.page} className="page">
          <summary>
            <b className="mono">{p.route ?? "(route 없음)"}</b>
            <span>{p.component}</span>
            <span className="muted">API {p.apis.length}개</span>
          </summary>
          <div>
            <div className="muted mono">
              {p.file} · <a href={ontologyHref(p)} target="_blank" rel="noreferrer">관계 그래프 열기</a>
            </div>
            {p.apis.map((a) => (
              <div key={a.api} className="api-row">
                <span className="mono">{a.api}</span>
                {a.fields > 0 && <span className="chip">필드 {a.fields}</span>}
                {a.common && <span className="chip">공통</span>}
                {a.status && a.status !== "matched" && <span className="chip">{a.status}</span>}
              </div>
            ))}
          </div>
        </details>
      ))}
      {shown.length > 300 && <p className="muted">처음 300개만 표시합니다. 검색으로 좁혀 주세요.</p>}
    </>
  );
}
