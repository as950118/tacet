import Link from "next/link";
import { getProjects } from "@/lib/data";
import type { ProjectInfo } from "@/lib/tacet";

export const dynamic = "force-dynamic";

const when = (side: ProjectInfo["frontend"]) => side?.generatedAt.slice(0, 16).replace("T", " ") ?? "—";

export default async function Home() {
  let projects: ProjectInfo[];
  try {
    projects = await getProjects();
  } catch (err) {
    return <div className="panel error">Tacet API에 연결하지 못했습니다: {(err as Error).message}</div>;
  }
  return (
    <>
      <h1>프로젝트</h1>
      <p className="muted">로컬에서 <code>tacet index … --index $DATABASE_URL -p &lt;name&gt;</code>으로 넣은 프로젝트입니다.</p>
      {projects.length === 0 && <div className="panel">아직 인덱싱된 프로젝트가 없습니다.</div>}
      <div className="grid">
        {projects.map((p) => (
          <Link key={p.name} href={`/p/${encodeURIComponent(p.name)}`} className="panel card">
            <b>{p.name}</b>
            <div className="muted">frontend {when(p.frontend)}</div>
            <div className="muted">backend {when(p.backend)}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
