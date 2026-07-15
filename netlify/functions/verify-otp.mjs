// netlify/functions/verify-otp.mjs
// 휴대폰 SMS 인증 — 코드 확인 후 phone_identity 에 인증 완료 기록
//
// 요청(JSON POST): { accessToken, phone, code, marketing }
//
// 필요한 Netlify 환경변수:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

// 관리자 알림 문자(솔라피). 환경변수 없으면 조용히 건너뜀.
async function notifyAdmin(text) {
  const KEY = process.env.SOLAPI_API_KEY, SECRET = process.env.SOLAPI_API_SECRET, FROM = onlyDigits(process.env.SOLAPI_SENDER), TO = onlyDigits(process.env.ADMIN_PHONE);
  if (!KEY || !SECRET || !FROM || !TO) return;
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString("hex");
  const signature = crypto.createHmac("sha256", SECRET).update(date + salt).digest("hex");
  await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `HMAC-SHA256 apiKey=${KEY}, date=${date}, salt=${salt}, signature=${signature}` },
    body: JSON.stringify({ message: { to: TO, from: FROM, text } }),
  });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  const accessToken = body.accessToken;
  const phone = onlyDigits(body.phone);
  const code = onlyDigits(body.code);
  const marketing = !!body.marketing;
  if (!accessToken || !phone || !code) return json({ error: "missing_params" }, 400);

  // 1) 사용자 검증
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }

  // 2) 대기 코드 조회
  let rec;
  try {
    const r = await sbFetch(SUPA, SERVICE, `phone_verifications?user_id=eq.${user.id}&select=*`);
    const rows = await r.json().catch(() => []);
    rec = rows[0];
  } catch (_) {}
  if (!rec) return json({ error: "no_code", message: "인증번호를 먼저 요청해 주세요." }, 400);
  if (new Date(rec.expires_at).getTime() < Date.now()) return json({ error: "expired", message: "인증번호가 만료됐어요. 다시 요청해 주세요." }, 400);
  if ((rec.attempts || 0) >= 5) return json({ error: "too_many", message: "시도 횟수를 초과했어요. 다시 요청해 주세요." }, 429);
  if (onlyDigits(rec.phone) !== phone) return json({ error: "phone_mismatch", message: "요청한 번호와 다릅니다." }, 400);

  // 3) 코드 대조
  const hash = crypto.createHash("sha256").update(code + user.id).digest("hex");
  if (hash !== rec.code_hash) {
    await sbFetch(SUPA, SERVICE, `phone_verifications?user_id=eq.${user.id}`, { method: "PATCH", body: JSON.stringify({ attempts: (rec.attempts || 0) + 1 }) });
    return json({ error: "wrong_code", message: "인증번호가 일치하지 않아요." }, 400);
  }

  // 4) 인증 완료 기록(서버 전용 테이블) + 대기코드 삭제
  const rowUp = await sbFetch(SUPA, SERVICE, "phone_identity?on_conflict=user_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: user.id, phone, verified: true, marketing_consent: marketing, verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  });
  if (!rowUp.ok) return json({ error: "db_error" }, 500);
  await sbFetch(SUPA, SERVICE, `phone_verifications?user_id=eq.${user.id}`, { method: "DELETE" });

  // 관리자에게 신규 가입(인증 완료) 알림 문자 — 실패해도 인증은 성공 처리
  try {
    const brand = process.env.OTP_BRAND || "쑥쑥AI";
    await notifyAdmin(`[${brand}] 새 회원 가입 · ${user.email || "-"} · ${phone}`);
  } catch (_) {}

  return json({ ok: true, message: "휴대폰 인증이 완료됐어요." });
};
