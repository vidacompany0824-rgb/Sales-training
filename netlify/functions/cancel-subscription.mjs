// netlify/functions/cancel-subscription.mjs
// 구독 해지 — 포트원 예약결제 취소 + 빌링키 삭제 + Supabase status='canceled'
//   현재 기간(current_period_end)까지는 계속 이용 가능(기간말 해지).
//
// 요청(JSON POST): { accessToken }
// 필요한 Netlify 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORTONE_API_SECRET

const PORTONE = "https://api.portone.io";
function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, PSECRET = process.env.PORTONE_API_SECRET;
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  const accessToken = body.accessToken;
  if (!accessToken) return json({ error: "missing_params" }, 400);

  // 1) 사용자 검증
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }

  // 2) 구독 조회 → billingKey
  let billingKey = null;
  try {
    const r = await fetch(`${SUPA}/rest/v1/subscriptions?user_id=eq.${user.id}&select=provider_customer_id,status`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    const rows = await r.json();
    billingKey = rows && rows[0] && rows[0].provider_customer_id;
  } catch (e) {}

  // 3) 포트원: 예약결제 취소 + 빌링키 삭제 (실패해도 진행 → DB 상태는 해지 반영)
  if (billingKey && PSECRET) {
    try {
      await fetch(`${PORTONE}/payment-schedules`, {
        method: "DELETE",
        headers: { Authorization: `PortOne ${PSECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ billingKey }),
      });
    } catch (_) {}
    try {
      await fetch(`${PORTONE}/billing-keys/${encodeURIComponent(billingKey)}`, {
        method: "DELETE",
        headers: { Authorization: `PortOne ${PSECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "사용자 구독 해지" }),
      });
    } catch (_) {}
  }

  // 4) Supabase 구독 상태 = canceled (기간말까지 이용 유지)
  try {
    await fetch(`${SUPA}/rest/v1/subscriptions?user_id=eq.${user.id}`, {
      method: "PATCH",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "canceled", updated_at: new Date().toISOString() }),
    });
  } catch (e) { return json({ error: "db_update_failed" }, 502); }

  return json({ ok: true, message: "구독이 해지되었습니다. 현재 이용 기간이 끝나면 자동 갱신되지 않습니다." });
};
