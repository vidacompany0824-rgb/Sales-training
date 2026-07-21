// netlify/functions/notify-challenge.mjs
// 챌린지 달성(거절강도5·90점+·4턴+) 발생 시 관리자에게 문자 1회 발송.
// 세션 1건당 1회만 발송(중복 방지: challenge_notified 표).
//
// 요청(JSON POST): { accessToken, sessionId }
// 필요한 Netlify 환경변수:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ADMIN_PHONE, SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER, OTP_BRAND(선택)

import crypto from "node:crypto";

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
const onlyDigits = (v) => String(v || "").replace(/[^0-9]/g, "");
async function sbGet(SUPA, SERVICE, path) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function sendSolapi(to, text) {
  const KEY = process.env.SOLAPI_API_KEY, SECRET = process.env.SOLAPI_API_SECRET, FROM = onlyDigits(process.env.SOLAPI_SENDER);
  if (!KEY || !SECRET || !FROM || !to) return;
  const date = new Date().toISOString(), salt = crypto.randomBytes(32).toString("hex");
  const signature = crypto.createHmac("sha256", SECRET).update(date + salt).digest("hex");
  await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `HMAC-SHA256 apiKey=${KEY}, date=${date}, salt=${salt}, signature=${signature}` },
    body: JSON.stringify({ message: { to, from: FROM, text } }),
  });
}

const REQ_COLD = 5, MIN_SCORE = 90, MIN_TURNS = 4;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  if (!body.accessToken || !body.sessionId) return json({ error: "missing_params" }, 400);

  // 사용자 확인
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${body.accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }

  // 세션 재검증(본인 세션 + 조건 충족)
  const rows = await sbGet(SUPA, SERVICE, `training_sessions?id=eq.${encodeURIComponent(body.sessionId)}&user_id=eq.${encodeURIComponent(user.id)}&select=id,cold,best_score,turns`);
  const s = Array.isArray(rows) ? rows[0] : null;
  if (!s) return json({ error: "session_not_found" }, 404);
  if (!(Number(s.cold) === REQ_COLD && Number(s.best_score) >= MIN_SCORE && Number(s.turns) >= MIN_TURNS)) {
    return json({ ok: true, skipped: "not_qualified" });
  }

  // 중복 방지: challenge_notified 에 insert (있으면 이미 알림 → 종료)
  try {
    const ins = await fetch(`${SUPA}/rest/v1/challenge_notified`, {
      method: "POST",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ session_id: s.id }),
    });
    if (ins.status === 409) return json({ ok: true, already: true });   // 이미 알림 보냄
    if (!ins.ok) { /* 표 없으면 그냥 발송(중복 위험은 클라 1회 호출로 최소화) */ }
  } catch (_) {}

  const brand = process.env.OTP_BRAND || "쑥쑥AI";
  try {
    await sendSolapi(onlyDigits(process.env.ADMIN_PHONE), `[${brand}] 🏆 챌린지 달성! ${user.email || "-"} · 거절강도5 최고 ${s.best_score}점 · 어드민에서 대화록 확인 후 상품권 지급하세요.`);
  } catch (_) {}

  return json({ ok: true, notified: true });
};
