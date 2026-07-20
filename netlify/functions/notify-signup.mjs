// netlify/functions/notify-signup.mjs
// 신규 가입 시 관리자에게 문자 1회 발송 (이메일·카카오·구글 가입 모두 커버).
// 재로그인엔 중복 발송되지 않도록 signup_notified 표로 서버에서 1회만 처리.
//
// 요청(JSON POST): { accessToken }
// 필요한 Netlify 환경변수:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ADMIN_PHONE, SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER  (문자 발송)
//   OTP_BRAND (선택, 기본 "쑥쑥AI")

import crypto from "node:crypto";

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
const onlyDigits = (v) => String(v || "").replace(/[^0-9]/g, "");

async function sendSolapi(to, text) {
  const KEY = process.env.SOLAPI_API_KEY, SECRET = process.env.SOLAPI_API_SECRET, FROM = onlyDigits(process.env.SOLAPI_SENDER);
  if (!KEY || !SECRET || !FROM || !to) return { ok: false, skipped: true };
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString("hex");
  const signature = crypto.createHmac("sha256", SECRET).update(date + salt).digest("hex");
  const res = await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `HMAC-SHA256 apiKey=${KEY}, date=${date}, salt=${salt}, signature=${signature}` },
    body: JSON.stringify({ message: { to, from: FROM, text } }),
  });
  return { ok: res.ok };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  if (!body.accessToken) return json({ error: "missing_params" }, 400);

  // 사용자 확인 (+ 가입 경로)
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${body.accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }

  // 중복 방지: 이미 알림 보낸 사용자면 여기서 종료 (insert 성공 = 최초 1회)
  let firstTime = false;
  try {
    const ins = await fetch(`${SUPA}/rest/v1/signup_notified`, {
      method: "POST",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ user_id: user.id }),
    });
    if (ins.ok) { const rows = await ins.json().catch(() => []); firstTime = Array.isArray(rows) && rows.length > 0; }
    else if (ins.status === 409) { firstTime = false; }         // 이미 존재(unique 충돌)
    else { return json({ ok: true, warning: "notify_table_missing" }); } // 표 없으면 조용히 통과(가입은 정상)
  } catch (e) { return json({ ok: true, warning: "dedupe_error" }); }

  if (!firstTime) return json({ ok: true, already: true });

  // 최초 1회만 관리자 문자 발송
  const prov = (user.app_metadata && (user.app_metadata.provider || (user.app_metadata.providers && user.app_metadata.providers[0]))) || "email";
  const provLabel = prov === "kakao" ? "카카오" : prov === "google" ? "구글" : "이메일";
  const brand = process.env.OTP_BRAND || "쑥쑥AI";
  try {
    await sendSolapi(onlyDigits(process.env.ADMIN_PHONE), `[${brand}] 🌱 새 회원 가입 · ${user.email || "-"} · ${provLabel} 가입 · 어드민에서 확인하세요.`);
  } catch (_) {}

  return json({ ok: true, notified: true });
};
