// netlify/functions/subscribe.mjs
// 세일즈 훈련 · 구독 결제 (포트원 V2 빌링키로 첫 결제 + 다음달 예약 + Supabase 구독 활성)
//
// 요청(JSON POST): { billingKey, accessToken }
//   - billingKey : 프론트에서 포트원 SDK로 발급한 빌링키
//   - accessToken: Supabase 로그인 세션 access_token (사용자 검증용)
//
// 필요한 Netlify 환경변수 (Site settings → Environment variables):
//   SUPABASE_URL                = https://pzotfitbuxwoaenvdfju.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   = (Supabase → Project Settings → API → service_role 키)
//   PORTONE_API_SECRET          = (포트원 콘솔 → API Keys → V2 API Secret)
//   SUBSCRIPTION_AMOUNT         = 9900   (선택, 미설정 시 9900)

import crypto from "node:crypto";

const PORTONE = "https://api.portone.io";

function json(o, s) {
  return new Response(JSON.stringify(o), {
    status: s || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// 관리자 알림 문자(솔라피). 환경변수(SOLAPI_*, ADMIN_PHONE) 없으면 조용히 건너뜀.
async function notifyAdmin(text) {
  const KEY = process.env.SOLAPI_API_KEY, SECRET = process.env.SOLAPI_API_SECRET;
  const FROM = String(process.env.SOLAPI_SENDER || "").replace(/[^0-9]/g, "");
  const TO = String(process.env.ADMIN_PHONE || "").replace(/[^0-9]/g, "");
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

  const SUPA = process.env.SUPABASE_URL;
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const PSECRET = process.env.PORTONE_API_SECRET;
  const AMOUNT = Number(process.env.SUBSCRIPTION_AMOUNT || 9900);
  if (!SUPA || !SERVICE || !PSECRET) return json({ error: "server_env_missing" }, 500);

  let body = {};
  try { body = await req.json(); } catch (_) {}
  const billingKey = body.billingKey;
  const accessToken = body.accessToken;
  if (!billingKey || !accessToken) return json({ error: "missing_params" }, 400);

  // 1) Supabase로 로그인 사용자 검증
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${accessToken}`, apikey: SERVICE },
    });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error", message: String(e) }, 401); }

  // 2) 빌링키로 첫 결제 (paymentId에 사용자 id를 담아 웹훅에서 식별)
  const paymentId = `sub_${user.id}_${Date.now()}`;
  let payJson;
  try {
    const pay = await fetch(`${PORTONE}/payments/${encodeURIComponent(paymentId)}/billing-key`, {
      method: "POST",
      headers: { Authorization: `PortOne ${PSECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        billingKey,
        orderName: "세일즈 훈련 구독 (월)",
        customer: { id: user.id, email: user.email || undefined },
        amount: { total: AMOUNT },
        currency: "KRW",
      }),
    });
    payJson = await pay.json().catch(() => ({}));
    if (!pay.ok) return json({ error: "payment_failed", detail: payJson }, 402);
  } catch (e) { return json({ error: "payment_error", message: String(e) }, 502); }

  // 2.5) 결제 로그 기록 (어드민 매출 집계용)
  try {
    await fetch(`${SUPA}/rest/v1/payments`, {
      method: "POST",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id, amount: AMOUNT, currency: "KRW", status: "paid", provider: "portone", payment_id: paymentId }),
    });
  } catch (_) { /* 로그 실패는 무시 */ }

  // 2.6) 관리자에게 결제 알림 문자 (실패해도 결제는 유효)
  try {
    const brand = process.env.OTP_BRAND || "쑥쑥AI";
    await notifyAdmin(`[${brand}] 💰 새 구독 결제 · ${user.email || "-"} · ${AMOUNT.toLocaleString("ko-KR")}원`);
  } catch (_) {}

  // 3) Supabase 구독 활성화 (+1개월) — service_role로 upsert
  const now = new Date();
  const next = new Date(now); next.setMonth(next.getMonth() + 1);
  try {
    const up = await fetch(`${SUPA}/rest/v1/subscriptions?on_conflict=user_id`, {
      method: "POST",
      headers: {
        apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        user_id: user.id, status: "active", plan: "pro", provider: "portone",
        provider_customer_id: billingKey, current_period_end: next.toISOString(),
        updated_at: now.toISOString(),
      }),
    });
    if (!up.ok) {
      const d = await up.text();
      return json({ ok: true, warning: "paid_but_db_update_failed", detail: d }, 200);
    }
  } catch (e) { return json({ ok: true, warning: "paid_but_db_error", message: String(e) }, 200); }

  // 4) 다음달 정기결제 예약 (실패해도 결제/구독은 유효 → 경고만)
  try {
    const nextPaymentId = `sub_${user.id}_${next.getTime()}`;
    await fetch(`${PORTONE}/payments/${encodeURIComponent(nextPaymentId)}/schedules`, {
      method: "POST",
      headers: { Authorization: `PortOne ${PSECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        payment: {
          billingKey, orderName: "세일즈 훈련 구독 (월)",
          customer: { id: user.id }, amount: { total: AMOUNT }, currency: "KRW",
        },
        timeToPay: next.toISOString(),
      }),
    });
  } catch (_) { /* 예약 실패는 웹훅/재시도로 보완 */ }

  return json({ ok: true, current_period_end: next.toISOString() });
};
