import Link from "next/link";
import { notFound } from "next/navigation";
import { refreshProject } from "@/app/actions";
import { PagesView } from "@/components/PagesView";
import { UnusedTable } from "@/components/UnusedTable";
import { getPages, getStatus, getUsage } from "@/lib/data";
import { TacetApiError, type IndexStatus } from "@/lib/tacet";

export const dynamic = "force-dynamic";

const TABS = { apis: "API 사용 현황", pages: "페이지 ↔ API" } as const;
type Tab = keyof typeof TABS;

export async function generateMetadata({ params }: { params: Promise<{ project: string }> }) {
  return { title: `${decodeURIComponent((await params).project)} · Tacet` };
}

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const project = decodeURIComponent((await params).project);
  const tab: Tab = (await searchParams).tab === "pages" ? "pages" : "apis";

  let status: IndexStatus;
  try {
    status = await getStatus(project);
  } catch (err) {
    if (err instanceof TacetApiError && err.status === 404) notFound();
    throw err;
  }

  return (
    <>
      <div className="muted">
        <Link href="/">프로젝트</Link> /
      </div>
      <div className="title-row">
        <h1>{project}</h1>
        <form action={refreshProject.bind(null, project)}>
          <button type="submit" title="다시 인덱싱한 뒤 최신 결과를 받아옵니다">새로고침</button>
        </form>
      </div>
      <div className="muted mono">
        {status.frontend?.rootDir ?? "frontend 없음"} · {status.backend?.rootDir ?? "backend 없음"}
      </div>
      <div className="stats">
        {Object.entries(status.summary).map(([k, v]) => (
          <div key={k} className="stat">
            <span className="muted">{k}</span>
            <b>{v.toLocaleString()}</b>
          </div>
        ))}
      </div>
      <nav className="tabs">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <Link key={t} href={`?tab=${t}`} className={t === tab ? "on" : ""}>
            {TABS[t]}
          </Link>
        ))}
      </nav>
      {tab === "apis" ? <ApisTab project={project} hasBackend={Boolean(status.backend)} /> : <PagesTab project={project} />}
    </>
  );
}

async function ApisTab({ project, hasBackend }: { project: string; hasBackend: boolean }) {
  if (!hasBackend) {
    return <div className="panel">backend가 인덱싱되지 않았습니다. 로컬에서 <code>tacet extract-backend</code>를 실행해 주세요.</div>;
  }
  const { totals: t, unresolvedCalls, rows } = await getUsage(project);
  return (
    <>
      <div className="stats">
        <div className="stat"><span className="muted">endpoints</span><b>{t.endpoints}</b></div>
        <div className="stat"><span className="muted">frontend 사용</span><b>{t.frontend}</b></div>
        <div className="stat"><span className="muted">service만 사용</span><b>{t.service}</b></div>
        <div className="stat"><span className="muted">client 선언만</span><b>{t.clientDeclared}</b></div>
        <div className="stat"><span className="muted">미사용</span><b>{t.unused}</b></div>
      </div>
      {unresolvedCalls > 0 && (
        <p className="muted">
          URL을 정적으로 알 수 없는 호출이 {unresolvedCalls}건 있어, 일부 &quot;미사용&quot;은 실제로 쓰일 수 있습니다.
        </p>
      )}
      <UnusedTable project={project} rows={rows} />
    </>
  );
}

async function PagesTab({ project }: { project: string }) {
  return <PagesView project={project} pages={await getPages(project)} />;
}
