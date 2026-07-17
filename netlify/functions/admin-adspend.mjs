// netlify/functions/admin-adspend.mjs
// 어드민 전용 · 기간별 광고비 저장
//
// 요청(JSON POST): { accessToken, days, amount }
//   days   : 조회 기간(일). 어드민 차트에서 고른 기간과 동일
//   amount : 그 기간에 집행한 광고비(원)
//
// 필요한 Netlify 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, ADMIN = (process.env.ADMIN_EMAIL || "").toLowerCase();
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  if (!body.accessToken) return json({ error: "missing_params" }, 400);

  // 어드민 검증
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${body.accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }
  if (!ADMIN || String(user.email || "").toLowerCase() !== ADMIN) return json({ error: "forbidden_not_admin" }, 403);

  const days = Math.min(365, Math.max(1, Math.round(Number(body.days) || 14)));
  const amount = Math.max(0, Math.round(Number(body.amount) || 0));

  try {
    const r = await fetch(`${SUPA}/rest/v1/ad_spend?on_conflict=range_days`, {
      method: "POST",
      headers: {
        apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ range_days: days, amount, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) return json({ error: "db_error", detail: await r.text() }, 500);
    return json({ ok: true, days, amount });
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
};
