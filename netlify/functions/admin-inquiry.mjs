// netlify/functions/admin-inquiry.mjs
// 어드민 전용 · 문의 처리 상태 변경 (+ '답변완료' 시 사용자에게 안내 메일 자동 발송)
//
// 요청(JSON POST): { accessToken, id, status, reply? }
//   status: "open"(미처리) | "in_progress"(처리중) | "answered"(답변완료)
//   reply : (선택) 답변완료 시 메일에 담을 답변/안내 문구
//
// 필요한 Netlify 환경변수:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL
//   (메일 발송 시) RESEND_API_KEY, RESEND_FROM   예: "쑥쑥AI <no-reply@ssukssukai.com>"
//   (선택) OTP_BRAND(기본 "쑥쑥AI"), APP_URL(기본 https://ssukssukai.com)

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
const ALLOWED = ["open", "in_progress", "answered"];
const esc = (v) => String(v == null ? "" : v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function sendEmail(to, subject, html) {
  const KEY = process.env.RESEND_API_KEY, FROM = process.env.RESEND_FROM;
  if (!KEY || !FROM || !to) return { ok: false, skipped: true };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  return { ok: r.ok, detail: r.ok ? null : await r.text().catch(() => "") };
}

function answerEmailHtml({ brand, appUrl, category, subject, message, reply }) {
  const box = (label, val) => val ? `<tr><td style="padding:4px 0;color:#6b7280;width:80px;vertical-align:top">${label}</td><td style="padding:4px 0;color:#1f2430">${esc(val)}</td></tr>` : "";
  const replyBlock = reply
    ? `<div style="margin:18px 0;padding:14px 16px;background:#f6faf0;border:1px solid #e2ecd5;border-radius:12px;color:#2c2c2a;line-height:1.7;white-space:pre-wrap">${esc(reply)}</div>`
    : `<p style="margin:18px 0;color:#374151;line-height:1.7">문의하신 내용이 처리 완료되었습니다. 추가로 궁금한 점이 있으시면 앱에서 언제든 다시 문의해 주세요.</p>`;
  return `<div style="max-width:520px;margin:0 auto;font-family:-apple-system,'Malgun Gothic',sans-serif;color:#1f2430">
    <div style="padding:22px 4px 14px;border-bottom:2px solid #3B6D11">
      <span style="font-size:20px;font-weight:800;color:#3B6D11">🌱 ${esc(brand)}</span>
    </div>
    <h2 style="font-size:18px;margin:22px 0 6px">문의가 처리 완료되었어요 ✅</h2>
    <p style="color:#6b7280;font-size:13px;margin:0">남겨주신 문의에 대한 답변입니다.</p>
    ${replyBlock}
    <table style="width:100%;font-size:13px;border-top:1px solid #eef1f5;margin-top:8px;padding-top:8px">
      ${box("분류", category)}${box("제목", subject)}${box("문의내용", message)}
    </table>
    <a href="${esc(appUrl)}" style="display:inline-block;margin-top:22px;background:#3B6D11;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">앱으로 이동</a>
    <p style="margin-top:26px;font-size:11px;color:#9aa3b2;border-top:1px solid #eef1f5;padding-top:12px">본 메일은 발신 전용입니다. 추가 문의는 앱 내 고객센터를 이용해 주세요.</p>
  </div>`;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, ADMIN = (process.env.ADMIN_EMAIL || "").toLowerCase();
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  if (!body.accessToken || !body.id || !ALLOWED.includes(body.status)) return json({ error: "bad_params" }, 400);

  // 어드민 검증
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${body.accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }
  if (!ADMIN || String(user.email || "").toLowerCase() !== ADMIN) return json({ error: "forbidden_not_admin" }, 403);

  const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

  // 현재 문의 조회(이전 상태·이메일·내용)
  let cur = null;
  try {
    const r = await fetch(`${SUPA}/rest/v1/inquiries?id=eq.${encodeURIComponent(body.id)}&select=id,email,status,category,subject,message`, { headers: H });
    const rows = await r.json().catch(() => []);
    cur = Array.isArray(rows) ? rows[0] : null;
  } catch (_) {}
  if (!cur) return json({ error: "inquiry_not_found" }, 404);

  const reply = (body.reply || "").toString().slice(0, 2000).trim() || null;
  const becomingAnswered = body.status === "answered" && cur.status !== "answered";

  // 상태 업데이트 (+ 답변완료면 답변·시각 저장)
  const patch = { status: body.status };
  if (body.status === "answered") { patch.answer_text = reply; patch.answered_at = new Date().toISOString(); }
  try {
    const r = await fetch(`${SUPA}/rest/v1/inquiries?id=eq.${encodeURIComponent(body.id)}`, { method: "PATCH", headers: H, body: JSON.stringify(patch) });
    if (!r.ok) return json({ error: "db_error", detail: await r.text() }, 500);
  } catch (e) { return json({ error: "server_error", message: String(e) }, 500); }

  // 답변완료로 '전환'된 경우에만 사용자에게 안내 메일 발송(중복 방지)
  let mail = { skipped: true };
  if (becomingAnswered && cur.email) {
    const brand = process.env.OTP_BRAND || "쑥쑥AI";
    const appUrl = process.env.APP_URL || "https://ssukssukai.com";
    try {
      mail = await sendEmail(cur.email, `[${brand}] 문의가 처리 완료되었어요`, answerEmailHtml({ brand, appUrl, category: cur.category, subject: cur.subject, message: cur.message, reply }));
    } catch (e) { mail = { ok: false, detail: String(e) }; }
  }

  return json({ ok: true, status: body.status, mailed: !!(mail && mail.ok), mailSkipped: !!(mail && mail.skipped) });
};
