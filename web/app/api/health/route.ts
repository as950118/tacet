import { apiConfig, tacetFetch } from "@/lib/tacet";

/** Whether the dashboard reaches the Tacet API, and with a token it accepts; never returns the token itself. */
export async function GET() {
  let url: string;
  try {
    url = apiConfig().url;
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
  const tokenSet = Boolean(process.env.TACET_API_TOKEN);
  try {
    const health = await tacetFetch("/health");
    const projects = await tacetFetch("/projects");
    return Response.json({
      ok: health.ok && projects.ok,
      api: url,
      tokenSet,
      health: health.status,
      projects: projects.status === 401 ? "401: TACET_API_TOKEN이 API 서버의 토큰과 다릅니다" : projects.status,
    });
  } catch (err) {
    return Response.json({ ok: false, api: url, tokenSet, error: (err as Error).message }, { status: 502 });
  }
}
