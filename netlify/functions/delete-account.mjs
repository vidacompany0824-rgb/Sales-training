// netlify/functions/delete-account.mjs
// 회원 탈퇴 (본인) — 로그인한 사용자가 자신의 계정과 데이터를 영구 삭제.
//
// 요청(JSON POST): { accessToken, reason? }
// 필요한 Netlify 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// 탈퇴 로그 기록 + 미답변 문의 보존. 삭제(purge) 직전에 호출.
// - 결제 이력/미답변 문의 유무를 먼저 조회해 account_deletions 에 남김
// - 미답변 문의는 user_id 만 분리(member_deleted=true)해 본문·이메일을 보존 → 탈퇴 후에도 답변 가능
export async function recordDeletion(SUPA, SERVICE, { uid, email, signupAt, kind, reason }) {
  const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
  const get = async (path) => { try { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: H }); return r.ok ? (await r.json().catch(() => [])) : []; } catch (_) { return []; } };

  const paidRows = await get(`payments?user_id=eq.${encodeURIComponent(uid)}&status=eq.paid&select=user_id&limit=1`);
  const openRows = await get(`inquiries?user_id=eq.${encodeURIComponent(uid)}&status=neq.answered&select=id&limit=1`);
  const hadPaid = Array.isArray(paidRows) && paidRows.length > 0;
  const openInquiry = Array.isArray(openRows) && openRows.length > 0;

  // 미답변 문의 보존(계정과 분리)
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
      body: JSON.stringify({ user_id: uid, email: email || null, kind: kind || "self", reason: reason || null, signup_at: signupAt || null, days_active: daysActive, had_paid: hadPaid, open_inquiry: openInquiry }),
    });
  } catch (_) {}
  return { hadPaid, openInquiry };
}

// 사용자 관련 데이터 정리(서버 권한). 없는 표/컬럼은 조용히 무시.
// ※ 미답변 문의는 위 recordDeletion 에서 user_id 를 분리했으므로 여기서 삭제되지 않음(답변완료 문의만 삭제됨).
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
    const reason = (body.reason || "").toString().slice(0, 300).trim() || null;
    await recordDeletion(SUPA, SERVICE, { uid: user.id, email: user.email, signupAt: user.created_at, kind: "self", reason });
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
