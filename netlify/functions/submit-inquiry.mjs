// netlify/functions/submit-inquiry.mjs
// 인앱 문의 접수 → DB 저장 + 관리자에게 SMS 알림(솔라피)
//
// 요청(JSON POST): { accessToken, category, subject, message }
//
// 필요한 Netlify 환경변수:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ADMIN_PHONE                      (문의 알림을 받을 번호, 숫자만. 예: 01067230560)
//   SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER   (이미 인증용으로 설정됨)
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
  const accessToken = body.accessToken;
  const category = (body.category || "기타").slice(0, 40);
  const subject = (body.subject || "").slice(0, 120);
  const message = (body.message || "").trim().slice(0, 2000);
  if (!accessToken || !message) return json({ error: "missing_params" }, 400);

  // 사용자 검증
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }

  // DB 저장
  const ins = await sbFetch(SUPA, SERVICE, "inquiries", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: user.id, email: user.email || null, category, subject: subject || null, message, status: "open" }),
  });
  if (!ins.ok) return json({ error: "db_error" }, 500);

  // 관리자 SMS 알림(실패해도 접수는 성공 처리)
  try {
    const brand = process.env.OTP_BRAND || "쑥쑥AI";
    await sendSolapi(onlyDigits(process.env.ADMIN_PHONE), `[${brand}] 새 문의 접수 · 분류:${category} · 어드민에서 확인하세요.`);
  } catch (_) {}

  return json({ ok: true, message: "문의가 접수됐어요." });
};
