// netlify/functions/admin-inquiry.mjs
// 어드민 전용 · 문의 처리 상태 변경
//
// 요청(JSON POST): { accessToken, id, status }
//   status: "open"(미처리) | "in_progress"(처리중) | "answered"(답변완료)
//
// 필요한 Netlify 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
const ALLOWED = ["open", "in_progress", "answered"];

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, ADMIN = (process.env.ADMIN_EMAIL || "").toLowerCase();
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  if (!body.accessToken || !body.id || !ALLOWED.includes(body.status)) return json({ error: "bad_params" }, 400);

  // 어드민 검증
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${body.accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }
  if (!ADMIN || String(user.email || "").toLowerCase() !== ADMIN) return json({ error: "forbidden_not_admin" }, 403);

  try {
    const r = await fetch(`${SUPA}/rest/v1/inquiries?id=eq.${encodeURIComponent(body.id)}`, {
      method: "PATCH",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: body.status }),
    });
    if (!r.ok) return json({ error: "db_error", detail: await r.text() }, 500);
    return json({ ok: true, status: body.status });
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
};
