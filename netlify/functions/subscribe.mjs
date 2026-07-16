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

const onlyDigits = (v) => String(v || "").replace(/[^0-9]/g, "");

// 솔라피 발송 공통(문자·알림톡). 키 없으면 조용히 건너뜀.
async function solapiSend(message) {
  const KEY = process.env.SOLAPI_API_KEY, SECRET = process.env.SOLAPI_API_SECRET;
  if (!KEY || !SECRET) return;
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString("hex");
  const signature = crypto.createHmac("sha256", SECRET).update(date + salt).digest("hex");
  await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `HMAC-SHA256 apiKey=${KEY}, date=${date}, salt=${salt}, signature=${signature}` },
    body: JSON.stringify({ message }),
  });
}
// 관리자 알림 문자
async function notifyAdmin(text) {
  const FROM = onlyDigits(process.env.SOLAPI_SENDER), TO = onlyDigits(process.env.ADMIN_PHONE);
  if (!FROM || !TO) return;
  await solapiSend({ to: TO, from: FROM, text });
}
// 사용자 알림톡(실패 시 문자 대체발송). SOLAPI_PFID·templateId 없으면 건너뜀.
async function sendAlimtalk(to, templateId, variables) {
  const FROM = onlyDigits(process.env.SOLAPI_SENDER), PF = process.env.SOLAPI_PFID;
  to = onlyDigits(to);
  if (!to || !FROM || !PF || !templateId) return;
  await solapiSend({ to, from: FROM, kakaoOptions: { pfId: PF, templateId, variables: variables || {}, disableSms: false } });
}
async function getUserPhone(SUPA, SERVICE, uid) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/phone_identity?user_id=eq.${uid}&select=phone`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    const arr = await r.json().catch(() => []);
    return arr[0] && arr[0].phone;
  } catch (_) { return null; }
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
  const promoCodeRaw = (body.promoCode || "").trim();
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

  // 1.5) 프로모션 코드 검증 → 첫 결제 할인가 계산 (코드가 없으면 정가)
  //      · 정률(percent): value% 할인   · 정액(fixed): value원 할인   · 첫 결제에만 적용
  let chargeAmount = AMOUNT;
  let appliedPromo = null;
  if (promoCodeRaw) {
    try {
      const pc = await fetch(`${SUPA}/rest/v1/promo_codes?select=*&code=eq.${encodeURIComponent(promoCodeRaw.toUpperCase())}`, {
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      });
      const rows = await pc.json().catch(() => []);
      const p = Array.isArray(rows) ? rows[0] : null;
      const now0 = Date.now();
      const usable = p && p.active
        && (!p.expires_at || new Date(p.expires_at).getTime() > now0)
        && (p.max_uses == null || (p.used_count || 0) < p.max_uses);
      if (!usable) return json({ error: "promo_invalid" }, 400);
      const disc = p.discount_type === "percent"
        ? Math.floor(AMOUNT * Math.min(100, p.discount_value) / 100)
        : p.discount_value;
      chargeAmount = Math.max(0, AMOUNT - disc);
      appliedPromo = p.code;
    } catch (e) { return json({ error: "promo_error", message: String(e) }, 500); }
  }

  // 2) 빌링키로 첫 결제 (paymentId에 사용자 id를 담아 웹훅에서 식별)
  //    할인 결과가 0원이면 첫 달은 결제 없이 활성화(빌링키는 다음 달 예약에 사용)
  const paymentId = `sub_${user.id}_${Date.now()}`;
  let payJson = { skipped: true };
  if (chargeAmount > 0) {
    try {
      const pay = await fetch(`${PORTONE}/payments/${encodeURIComponent(paymentId)}/billing-key`, {
        method: "POST",
        headers: { Authorization: `PortOne ${PSECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          billingKey,
          orderName: "쑥쑥AI 구독 (월)",
          customer: { id: user.id, email: user.email || undefined },
          amount: { total: chargeAmount },
          currency: "KRW",
        }),
      });
      payJson = await pay.json().catch(() => ({}));
      if (!pay.ok) return json({ error: "payment_failed", detail: payJson }, 402);
    } catch (e) { return json({ error: "payment_error", message: String(e) }, 502); }
  }

  // 2.4) 프로모 코드 사용횟수 +1 (결제 성공 후)
  if (appliedPromo) {
    try {
      await fetch(`${SUPA}/rest/v1/rpc/bump_promo_use`, {
        method: "POST",
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_code: appliedPromo }),
      });
    } catch (_) {}
  }

  // 2.5) 결제 로그 기록 (어드민 매출 집계용)
  try {
    await fetch(`${SUPA}/rest/v1/payments`, {
      method: "POST",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id, amount: chargeAmount, currency: "KRW", status: "paid", provider: "portone", payment_id: paymentId, promo_code: appliedPromo }),
    });
  } catch (_) { /* 로그 실패는 무시 */ }

  // 2.6) 관리자에게 결제 알림 문자 (실패해도 결제는 유효)
  try {
    const brand = process.env.OTP_BRAND || "쑥쑥AI";
    const promoTxt = appliedPromo ? ` · 코드:${appliedPromo}` : "";
    await notifyAdmin(`[${brand}] 💰 새 구독 결제 · ${user.email || "-"} · ${chargeAmount.toLocaleString("ko-KR")}원${promoTxt}`);
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

  // 3.5) 사용자에게 결제 완료 알림톡(정보성)
  try {
    const uphone = await getUserPhone(SUPA, SERVICE, user.id);
    if (uphone) await sendAlimtalk(uphone, process.env.ALIMTALK_TPL_PAYMENT, { "#{금액}": chargeAmount.toLocaleString("ko-KR"), "#{다음결제일}": next.toISOString().slice(0, 10) });
  } catch (_) {}

  // 4) 다음달 정기결제 예약 (실패해도 결제/구독은 유효 → 경고만)
  try {
    const nextPaymentId = `sub_${user.id}_${next.getTime()}`;
    await fetch(`${PORTONE}/payments/${encodeURIComponent(nextPaymentId)}/schedules`, {
      method: "POST",
      headers: { Authorization: `PortOne ${PSECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        payment: {
          billingKey, orderName: "쑥쑥AI 구독 (월)",
          customer: { id: user.id }, amount: { total: AMOUNT }, currency: "KRW",
        },
        timeToPay: next.toISOString(),
      }),
    });
  } catch (_) { /* 예약 실패는 웹훅/재시도로 보완 */ }

  return json({ ok: true, current_period_end: next.toISOString() });
};
