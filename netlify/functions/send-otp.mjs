// netlify/functions/send-otp.mjs
// 휴대폰 SMS 인증 — 인증코드 발송 (Solapi 문자 대행)
//
// 요청(JSON POST): { accessToken, phone }
//   - accessToken : Supabase 로그인 세션 access_token
//   - phone       : 휴대폰 번호(숫자만 또는 하이픈 포함, 01012345678)
//
// 필요한 Netlify 환경변수:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER (사전등록된 발신번호)
//   OTP_BRAND (선택, 기본 "쑥쑥AI")

import crypto from "node:crypto";

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
const onlyDigits = (v) => String(v || "").replace(/[^0-9]/g, "");

async function sbFetch(SUPA, SERVICE, path, init = {}) {
  return fetch(`${SUPA}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

async function sendSolapi(phone, text) {
  const KEY = process.env.SOLAPI_API_KEY, SECRET = process.env.SOLAPI_API_SECRET, FROM = onlyDigits(process.env.SOLAPI_SENDER);
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString("hex");
  const signature = crypto.createHmac("sha256", SECRET).update(date + salt).digest("hex");
  const res = await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `HMAC-SHA256 apiKey=${KEY}, date=${date}, salt=${salt}, signature=${signature}` },
    body: JSON.stringify({ message: { to: phone, from: FROM, text } }),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: j };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA || !SERVICE || !process.env.SOLAPI_API_KEY || !process.env.SOLAPI_API_SECRET || !process.env.SOLAPI_SENDER)
    return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  const accessToken = body.accessToken;
  const phone = onlyDigits(body.phone);
  if (!accessToken) return json({ error: "missing_params" }, 400);
  if (!/^01[0-9]{8,9}$/.test(phone)) return json({ error: "invalid_phone" }, 400);

  // 1) 사용자 검증
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }

  // 2) 재전송 쿨다운(60초)
  try {
    const r = await sbFetch(SUPA, SERVICE, `phone_verifications?user_id=eq.${user.id}&select=last_sent_at`);
    const rows = await r.json().catch(() => []);
    if (rows[0] && rows[0].last_sent_at && (Date.now() - new Date(rows[0].last_sent_at).getTime()) < 60000)
      return json({ error: "cooldown", message: "잠시 후 다시 시도해 주세요(60초)." }, 429);
  } catch (_) {}

  // 3) 코드 생성 + 해시 저장
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const code_hash = crypto.createHash("sha256").update(code + user.id).digest("hex");
  const expires_at = new Date(Date.now() + 5 * 60000).toISOString();
  const row = { user_id: user.id, phone, code_hash, expires_at, attempts: 0, last_sent_at: new Date().toISOString() };
  const up = await sbFetch(SUPA, SERVICE, "phone_verifications?on_conflict=user_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row),
  });
  if (!up.ok) return json({ error: "db_error" }, 500);

  // 4) SMS 발송
  const brand = process.env.OTP_BRAND || "쑥쑥AI";
  const sms = await sendSolapi(phone, `[${brand}] 인증번호 [${code}] 를 입력해 주세요. (5분 내 유효)`);
  if (!sms.ok) return json({ error: "sms_failed", detail: sms.body }, 502);

  return json({ ok: true, message: "인증번호를 전송했어요." });
};
