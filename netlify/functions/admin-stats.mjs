// netlify/functions/admin-stats.mjs
// 마스터 어드민 통계 — 어드민 이메일로 로그인한 경우에만 집계 반환.
//   방문자/체류/이탈 · 결제자/결제건수/결제금액 · 구독자수 · 사용자별 세션수
//
// 요청(JSON POST): { accessToken }
// 필요한 Netlify 환경변수:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL (어드민 계정 이메일)

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
async function sbGet(SUPA, SERVICE, path) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const SUPA = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY, ADMIN = (process.env.ADMIN_EMAIL || "").toLowerCase();
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  let body = {}; try { body = await req.json(); } catch (_) {}
  if (!body.accessToken) return json({ error: "missing_params" }, 400);

  // 어드민 검증
  let user;
  try {
    const ures = await fetch(`${SUPA}/auth/v1/user`, { headers: { Authorization: `Bearer ${body.accessToken}`, apikey: SERVICE } });
    user = await ures.json();
    if (!ures.ok || !user || !user.id) return json({ error: "auth_failed" }, 401);
  } catch (e) { return json({ error: "auth_error" }, 401); }
  if (!ADMIN || String(user.email || "").toLowerCase() !== ADMIN) return json({ error: "forbidden_not_admin" }, 403);

  // 데이터 수집
  const now = Date.now();
  const [payments, subs, sessions, pageviews, exits, profiles] = await Promise.all([
    sbGet(SUPA, SERVICE, "payments?select=user_id,amount,status,paid_at&order=paid_at.desc&limit=2000"),
    sbGet(SUPA, SERVICE, "subscriptions?select=user_id,status,current_period_end"),
    sbGet(SUPA, SERVICE, "training_sessions?select=user_id,created_at&limit=5000"),
    sbGet(SUPA, SERVICE, "analytics_events?type=eq.pageview&select=visit_id,page,created_at&order=created_at.desc&limit=5000"),
    sbGet(SUPA, SERVICE, "analytics_events?type=eq.exit&select=page,duration_sec,created_at&order=created_at.desc&limit=5000"),
    sbGet(SUPA, SERVICE, "profiles?select=id,email,display_name,created_at"),
  ]);

  // 결제 집계
  const paid = payments.filter(p => p.status === "paid");
  const payAmount = paid.reduce((a, p) => a + (+p.amount || 0), 0);
  const payers = new Set(paid.map(p => p.user_id).filter(Boolean)).size;

  // 구독자 수 (기간 유효)
  const subscribers = subs.filter(s => ["active", "canceled"].includes(s.status) && s.current_period_end && new Date(s.current_period_end).getTime() > now).length;
  const activeSubs = subs.filter(s => s.status === "active").length;

  // 사용자별 세션수
  const sessMap = {};
  sessions.forEach(s => { if (s.user_id) sessMap[s.user_id] = (sessMap[s.user_id] || 0) + 1; });
  const emailById = {}; profiles.forEach(p => { emailById[p.id] = p.email || p.display_name || p.id.slice(0, 8); });
  const perUser = Object.keys(sessMap).map(uid => ({ user: emailById[uid] || uid.slice(0, 8), sessions: sessMap[uid] }))
    .sort((a, b) => b.sessions - a.sessions).slice(0, 30);

  // 방문/체류/이탈
  const visitors = new Set(pageviews.map(v => v.visit_id).filter(Boolean)).size;
  const totalPageviews = pageviews.length;
  const durs = exits.map(e => +e.duration_sec || 0).filter(d => d > 0);
  const avgDuration = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
  const exitMap = {};
  exits.forEach(e => { const pg = e.page || "(unknown)"; exitMap[pg] = (exitMap[pg] || 0) + 1; });
  const exitPages = Object.keys(exitMap).map(pg => ({ page: pg, count: exitMap[pg] })).sort((a, b) => b.count - a.count).slice(0, 10);

  const totalSessions = sessions.length;

  // ===== 일자별 시계열(최근 14일) — 카드별 그래프용 =====
  const DAYS = 14;
  const dayKeys = [];
  for (let i = DAYS - 1; i >= 0; i--) dayKeys.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  const zero = () => dayKeys.reduce((o, d) => (o[d] = 0, o), {});
  const dVisitors = {}; // day -> Set(visit_id)
  const dPageviews = zero(), dSessions = zero(), dPayCount = zero(), dPayAmount = zero(), dNewUsers = zero();
  pageviews.forEach(v => { const d = (v.created_at || "").slice(0, 10); if (d in dPageviews) { dPageviews[d]++; (dVisitors[d] = dVisitors[d] || new Set()).add(v.visit_id); } });
  sessions.forEach(s => { const d = (s.created_at || "").slice(0, 10); if (d in dSessions) dSessions[d]++; });
  paid.forEach(p => { const d = (p.paid_at || "").slice(0, 10); if (d in dPayCount) { dPayCount[d]++; dPayAmount[d] += (+p.amount || 0); } });
  profiles.forEach(u => { const d = (u.created_at || "").slice(0, 10); if (d in dNewUsers) dNewUsers[d]++; });
  const series = {
    days: dayKeys,
    visitors: dayKeys.map(d => (dVisitors[d] ? dVisitors[d].size : 0)),
    pageviews: dayKeys.map(d => dPageviews[d]),
    sessions: dayKeys.map(d => dSessions[d]),
    payCount: dayKeys.map(d => dPayCount[d]),
    payAmount: dayKeys.map(d => dPayAmount[d]),
    newUsers: dayKeys.map(d => dNewUsers[d]),
  };
  // 하위호환: 기존 매출 차트용
  const revenueByDay = dayKeys.map(d => ({ day: d, amount: dPayAmount[d] }));

  return json({
    ok: true,
    kpi: {
      visitors, totalPageviews, avgDuration,
      payers, payCount: paid.length, payAmount,
      subscribers, activeSubs, totalUsers: profiles.length, totalSessions,
    },
    exitPages, perUser, revenueByDay, series,
  });
};
