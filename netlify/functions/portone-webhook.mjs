// netlify/functions/portone-webhook.mjs
// 포트원 웹훅 수신 — 정기(예약) 결제 결과를 Supabase 구독에 반영.
//  - 결제 성공: 구독 +1개월 연장 + 다음달 재예약(롤링)
//  - 결제 실패: 구독 past_due 로 표시
//
// 포트원 콘솔 → 웹훅에 이 함수 URL을 등록하세요:
//   https://<사이트>/.netlify/functions/portone-webhook
//
// 필요한 Netlify 환경변수:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORTONE_API_SECRET
//   PORTONE_WEBHOOK_SECRET (선택: 서명 검증용 — 등록 시 발급되는 시크릿)
//   SUBSCRIPTION_AMOUNT (선택, 기본 9900)

const PORTONE = "https://api.portone.io";

function ok(msg) { return new Response(msg || "ok", { status: 200 }); }

// paymentId 형식: sub_<userId(uuid)>_<timestamp>
function userIdFromPaymentId(pid) {
  if (!pid || pid.indexOf("sub_") !== 0) return null;
  const rest = pid.slice(4);
  const i = rest.lastIndexOf("_");
  return i > 0 ? rest.slice(0, i) : rest;
}

async function getBillingKey(SUPA, SERVICE, userId) {
  try {
    const r = await fetch(`${SUPA}/rest/v1/subscriptions?user_id=eq.${userId}&select=provider_customer_id`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    const rows = await r.json();
    return (rows && rows[0] && rows[0].provider_customer_id) || null;
  } catch (_) { return null; }
}

async function updateSub(SUPA, SERVICE, userId, fields) {
  await fetch(`${SUPA}/rest/v1/subscriptions?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
}

export default async (req) => {
  const SUPA = process.env.SUPABASE_URL;
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const PSECRET = process.env.PORTONE_API_SECRET;
  const AMOUNT = Number(process.env.SUBSCRIPTION_AMOUNT || 9900);

  const raw = await req.text();
  // TODO(권장): PORTONE_WEBHOOK_SECRET 로 서명 검증 후 처리
  let body = {};
  try { body = JSON.parse(raw); } catch (_) {}

  // V2 웹훅: type(예: "Transaction.Paid" / "Transaction.Failed"), data.paymentId
  const type = body.type || "";
  const paymentId = (body.data && (body.data.paymentId || body.data.payment_id)) || "";
  const userId = userIdFromPaymentId(paymentId);
  if (!userId || !SUPA || !SERVICE) return ok("skip");

  const isPaid = /paid/i.test(type) || /Transaction\.Paid/.test(type);
  const isFailed = /fail|cancel/i.test(type);

  try {
    if (isPaid) {
      const now = new Date();
      const next = new Date(now); next.setMonth(next.getMonth() + 1);
      await updateSub(SUPA, SERVICE, userId, {
        status: "active", current_period_end: next.toISOString(), updated_at: now.toISOString(),
      });
      // 다음 달 재예약(롤링)
      const bk = await getBillingKey(SUPA, SERVICE, userId);
      if (bk && PSECRET) {
        const nextPaymentId = `sub_${userId}_${next.getTime()}`;
        await fetch(`${PORTONE}/payments/${encodeURIComponent(nextPaymentId)}/schedules`, {
          method: "POST",
          headers: { Authorization: `PortOne ${PSECRET}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            payment: { billingKey: bk, orderName: "세일즈 훈련 구독 (월)", customer: { id: userId }, amount: { total: AMOUNT }, currency: "KRW" },
            timeToPay: next.toISOString(),
          }),
        });
      }
    } else if (isFailed) {
      await updateSub(SUPA, SERVICE, userId, { status: "past_due", updated_at: new Date().toISOString() });
    }
  } catch (_) { /* 웹훅은 200을 돌려주고, 실패는 포트원이 재전송 */ }

  return ok();
};
