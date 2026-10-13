import Link from "next/link";

export default function NotFound() {
  return (
    <div className="panel">
      그런 프로젝트가 없습니다. <Link href="/">프로젝트 목록</Link>
    </div>
  );
}
