import { tacetFetch } from "@/lib/tacet";

/**
 * Read-only pass-through to the Tacet API for what the browser opens directly (the ontology / graph HTML viewers),
 * so the API token stays on the server.
 */
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const search = new URL(req.url).search;
  const res = await tacetFetch(`/${path.map(encodeURIComponent).join("/")}${search}`);
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") ?? "application/octet-stream", "Cache-Control": "no-store" },
  });
}
