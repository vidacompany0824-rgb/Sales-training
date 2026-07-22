// netlify/functions/admin-delete-user.mjs
// 관리자 강제 탈퇴 — 어드민이 특정 회원의 계정과 데이터를 영구 삭제.
//
// 요청(JSON POST): { accessToken, userId, reason? }
// 필요한 Netlify 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// 탈퇴 로그 기록 + 미답변 문의 보존. (delete-account.mjs 와 동일 로직 · 번들 안정성 위해 인라인)
async function recordDeletion(SUPA, SERVICE, { uid, email, signupAt, kind, reason }) {
  const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
  const get = async (path) => { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: H }); return r.ok ? (await r.json().catch(() => [])) : []; } catch (_) { return []; } };
  const paidRows = await get(`payments?user_id=eq.${encodeURIComponent(uid)}&status=eq.paid&select=user_id&limit=1`);
  const openRows = await get(`inquiries?user_id=eq.${encodeURIComponent(uid)}&status=neq.answered&select=id&limit=1`);
  const hadPaid = Array.isArray(paidRows) && paidRows.length > 0;
  const openInquiry = Array.isArray(openRows) && openRows.length > 0;
  if (openInquiry) {
    try {
      await fetch(`${SUPA}/rest/v1/inquiries?user_id=eq.${encodeURIComponent(uid)}&status=neq.answered`, {
        method: "PATCH", headers: H, body: JSON.stringify({ member_deleted: true, user_id: null }),
      });
    } catch (_) {}
  }
  const daysActive = signupAt ? Math.max(0, Math.floor((Date.now() - new Date(signupAt).getTime()) / 86400000)) : null;
  try {
    await fetch(`${SUPA}/rest/v1/account_deletions`, {
      method: "POST", headers: H,
      body: JSON.stringify({ user_id: uid, email: email || null, kind: kind || "admin", reason: reason || null, signup_at: signupAt || null, days_active: daysActive, had_paid: hadPaid, open_inquiry: openInquiry }),
    });
  } catch (_) {}
}

// 사용자 관련 데이터 정리(서버 권한). 없는 표/컬럼은 조용히 무시.
// ※ 미답변 문의는 recordDeletion 에서 user_id 를 분리했으므로 여기서 삭제되지 않음.
async function purgeUserData(SUPA, SERVICE, uid) {
  const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
  const del = (path) => fetch(`${SUPA}/rest/v1/${path}`, { method: "DELETE", headers: H }).catch(() => {});
  const tables = [
    "training_sessions", "analytics_events", "payments", "inquiries",
    "subscriptions", "phone_verifications", "phone_identity",
    "marketing_consent_log", "challenge_reminder", "signup_notified", "profiles",
  ];
  for (const t of tables) { try { await del(`${t}?user_id=eq.${encodeURIComponent(uid)}`); } catch (_) {} }
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, ADMIN = (process.env.ADMIN_EMAIL || "").toLowerCase();
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  if (!body.accessToken || !body.userId) return json({ error: "missing_params" }, 400);

  // 어드민 검증
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${body.accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }
  if (!ADMIN || String(user.email || "").toLowerCase() !== ADMIN) return json({ error: "forbidden_not_admin" }, 403);
  if (String(body.userId) === String(user.id)) return json({ error: "cannot_delete_self" }, 400);   // 관리자 본인 계정 보호

  try {
    // 대상 회원 정보(이메일·가입일) 조회 → 로그에 남김
    let tEmail = null, tSignup = null;
    try {
      const tr = await fetch(`${SUPA}/auth/v1/admin/users/${encodeURIComponent(body.userId)}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
      const tj = await tr.json().catch(() => ({}));
      tEmail = tj.email || null; tSignup = tj.created_at || null;
    } catch (_) {}

    const reason = (body.reason || "관리자 강제 탈퇴").toString().slice(0, 300).trim() || null;
    await recordDeletion(SUPA, SERVICE, { uid: body.userId, email: tEmail, signupAt: tSignup, kind: "admin", reason });
    await purgeUserData(SUPA, SERVICE, body.userId);
    const r = await fetch(`${SUPA}/auth/v1/admin/users/${encodeURIComponent(body.userId)}`, {
      method: "DELETE", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    if (!r.ok && r.status !== 404) return json({ error: "delete_failed", detail: await r.text() }, 500);
    return json({ ok: true });
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
};
