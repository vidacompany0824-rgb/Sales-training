// netlify/functions/delete-account.mjs
// 회원 탈퇴 (본인) — 로그인한 사용자가 자신의 계정과 데이터를 영구 삭제.
//
// 요청(JSON POST): { accessToken }
// 필요한 Netlify 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// 사용자 관련 데이터 정리(서버 권한). 없는 표/컬럼은 조용히 무시.
export async function purgeUserData(SUPA, SERVICE, uid) {
  const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
  const del = (path) => fetch(`${SUPA}/rest/v1/${path}`, { method: "DELETE", headers: H }).catch(() => {});
  // training_sessions 삭제 시 challenge_awards/challenge_notified(세션 FK)도 함께 삭제됨
  const tables = [
    "training_sessions", "analytics_events", "payments", "inquiries",
    "subscriptions", "phone_verifications", "phone_identity",
    "marketing_consent_log", "challenge_reminder", "signup_notified", "profiles",
  ];
  for (const t of tables) { try { await del(`${t}?user_id=eq.${encodeURIComponent(uid)}`); } catch (_) {} }
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  if (!body.accessToken) return json({ error: "missing_params" }, 400);

  // 본인 확인
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${body.accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }

  try {
    await purgeUserData(SUPA, SERVICE, user.id);
    const r = await fetch(`${SUPA}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
      method: "DELETE", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    if (!r.ok && r.status !== 404) return json({ error: "delete_failed", detail: await r.text() }, 500);
    return json({ ok: true });
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
};
