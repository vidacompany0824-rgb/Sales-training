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
// PostgREST는 한 요청당 최대 1,000행만 반환(db-max-rows) → Range로 페이지 단위로 전부 받아옴.
// 큰 테이블(pageview/session/payment/stage 등)의 카운트가 1,000에서 잘리는 문제 해결.
async function sbGetAll(SUPA, SERVICE, path) {
  const PAGE = 1000, MAX_PAGES = 60;   // 안전 상한 6만 행
  let from = 0, out = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await fetch(`${SUPA}/rest/v1/${path}`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Range-Unit": "items", Range: `${from}-${from + PAGE - 1}` },
    });
    if (!r.ok) break;
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) break;
    out = out.concat(rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
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
  const [payments, subs, sessions, pageviews, exits, profiles, phones, inquiries, promos, adSpendRows, stageEvents, challengeSessions, challengeAwards, deletions] = await Promise.all([
    sbGetAll(SUPA, SERVICE, "payments?select=user_id,amount,status,paid_at&order=paid_at.desc"),
    sbGetAll(SUPA, SERVICE, "subscriptions?select=user_id,status,current_period_end"),
    sbGetAll(SUPA, SERVICE, "training_sessions?select=user_id,created_at&order=created_at.desc"),
    sbGetAll(SUPA, SERVICE, "analytics_events?type=eq.pageview&select=visit_id,page,created_at&order=created_at.desc"),
    sbGetAll(SUPA, SERVICE, "analytics_events?type=eq.exit&select=page,duration_sec,created_at&order=created_at.desc"),
    sbGetAll(SUPA, SERVICE, "profiles?select=id,email,display_name,created_at&order=created_at.desc"),
    sbGetAll(SUPA, SERVICE, "phone_identity?select=user_id,phone,verified,marketing_consent"),
    sbGet(SUPA, SERVICE, "inquiries?select=id,email,category,subject,message,status,member_deleted,created_at&order=created_at.desc&limit=200"),
    sbGet(SUPA, SERVICE, "promo_codes?select=*&order=created_at.desc&limit=200"),
    sbGet(SUPA, SERVICE, "ad_spend?select=range_days,amount"),
    sbGetAll(SUPA, SERVICE, "analytics_events?type=eq.stage&select=visit_id,page,created_at&order=created_at.desc"),
    sbGetAll(SUPA, SERVICE, "training_sessions?cold=eq.5&best_score=gte.90&turns=gte.4&select=id,user_id,persona_name,cold,avg_score,best_score,turns,created_at&order=created_at.desc"),
    sbGet(SUPA, SERVICE, "challenge_awards?select=session_id,email,amount,created_at"),
    sbGetAll(SUPA, SERVICE, "account_deletions?select=user_id,email,kind,reason,signup_at,days_active,had_paid,open_inquiry,deleted_at&order=deleted_at.desc"),
  ]);

  // 가입 경로(provider): GoTrue admin API 에서 조회
  const providerById = {};
  try {
    const ar = await fetch(`${SUPA}/auth/v1/admin/users?per_page=1000`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    const aj = await ar.json().catch(() => ({}));
    const users = Array.isArray(aj) ? aj : (aj.users || []);
    users.forEach(u => {
      const p = (u.app_metadata && (u.app_metadata.provider || (u.app_metadata.providers && u.app_metadata.providers[0])))
        || (u.identities && u.identities[0] && u.identities[0].provider) || "email";
      providerById[u.id] = p;
    });
  } catch (_) {}

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

  // ===== 일자별 시계열 — 상세 추이 차트용 (기간은 프론트에서 선택: 기본 14일) =====
  const DAYS = Math.min(365, Math.max(7, Math.round(Number(body.days) || 14)));
  const dayKeys = [];
  for (let i = DAYS - 1; i >= 0; i--) dayKeys.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  const zero = () => dayKeys.reduce((o, d) => (o[d] = 0, o), {});
  const dVisitors = {}; // day -> Set(visit_id)
  const dPageviews = zero(), dSessions = zero(), dPayCount = zero(), dPayAmount = zero(), dNewUsers = zero(), dDeletions = zero();
  pageviews.forEach(v => { const d = (v.created_at || "").slice(0, 10); if (d in dPageviews) { dPageviews[d]++; (dVisitors[d] = dVisitors[d] || new Set()).add(v.visit_id); } });
  sessions.forEach(s => { const d = (s.created_at || "").slice(0, 10); if (d in dSessions) dSessions[d]++; });
  paid.forEach(p => { const d = (p.paid_at || "").slice(0, 10); if (d in dPayCount) { dPayCount[d]++; dPayAmount[d] += (+p.amount || 0); } });
  profiles.forEach(u => { const d = (u.created_at || "").slice(0, 10); if (d in dNewUsers) dNewUsers[d]++; });
  (deletions || []).forEach(x => { const d = (x.deleted_at || "").slice(0, 10); if (d in dDeletions) dDeletions[d]++; });
  const series = {
    days: dayKeys,
    visitors: dayKeys.map(d => (dVisitors[d] ? dVisitors[d].size : 0)),
    pageviews: dayKeys.map(d => dPageviews[d]),
    sessions: dayKeys.map(d => dSessions[d]),
    payCount: dayKeys.map(d => dPayCount[d]),
    payAmount: dayKeys.map(d => dPayAmount[d]),
    newUsers: dayKeys.map(d => dNewUsers[d]),
    deletions: dayKeys.map(d => dDeletions[d]),
  };
  // 하위호환: 기존 매출 차트용
  const revenueByDay = dayKeys.map(d => ({ day: d, amount: dPayAmount[d] }));

  // 광고 효율용: 선택 기간 내 '순 결제자 수'(중복 제거) — 일별 합으로는 구할 수 없어 여기서 계산
  const winStart = dayKeys[0];
  const rangePayers = new Set(
    paid.filter(p => (p.paid_at || "").slice(0, 10) >= winStart).map(p => p.user_id).filter(Boolean)
  ).size;
  // 기간별 광고비 { range_days: amount }
  const adSpend = {};
  (adSpendRows || []).forEach(r => { adSpend[r.range_days] = +r.amount || 0; });

  // ===== 철벽 고객 챌린지 (거절강도5·90점+·4턴+ 달성자) =====
  const chEmailById = {}; (profiles || []).forEach(u => { chEmailById[u.id] = u.email; });
  const chPhoneById = {}; (phones || []).forEach(p => { chPhoneById[p.user_id] = p.verified ? (p.phone || "") : ""; });
  const paidBySession = {}; (challengeAwards || []).forEach(a => { paidBySession[a.session_id] = a; });
  const challengers = (challengeSessions || []).map(s => ({
    session_id: s.id, user_id: s.user_id,
    email: chEmailById[s.user_id] || "",
    phone: chPhoneById[s.user_id] || "",
    persona: s.persona_name || "", best: s.best_score, avg: s.avg_score, turns: s.turns,
    at: s.created_at, paid: !!paidBySession[s.id],
  }));
  const CH_PRIZE = Number(process.env.CHALLENGE_PRIZE || 50000);
  const CH_BUDGET = Number(process.env.CHALLENGE_BUDGET || 1000000);
  const chUsed = (challengeAwards || []).reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const chToday = (challengeAwards || []).filter(x => (x.created_at || "").slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const challenge = { prize: CH_PRIZE, budget: CH_BUDGET, used: chUsed, remaining: Math.max(0, CH_BUDGET - chUsed), paidCount: (challengeAwards || []).length, todayCount: chToday, achievers: challengers.length };

  // 온보딩 퍼널: 각 단계에 '도달한 순 방문 수'(기간 내, 중복 제거)
  const stageVisits = {};
  (stageEvents || []).forEach(e => { const d = (e.created_at || "").slice(0, 10); if (d >= winStart && e.page) { (stageVisits[e.page] = stageVisits[e.page] || new Set()).add(e.visit_id); } });
  const stageCounts = {};
  Object.keys(stageVisits).forEach(k => { stageCounts[k] = stageVisits[k].size; });
  // 기간 내 순 방문자(퍼널 1단계 기준)
  const periodVisitors = new Set(pageviews.filter(v => (v.created_at || "").slice(0, 10) >= winStart).map(v => v.visit_id).filter(Boolean)).size;

  // ===== 고객 원장 (CRM) =====
  const phoneById = {}; phones.forEach(p => { phoneById[p.user_id] = p; });
  const subStatusById = {};
  subs.forEach(s => {
    const valid = s.current_period_end && new Date(s.current_period_end).getTime() > now;
    if (["active", "canceled"].includes(s.status) && valid) subStatusById[s.user_id] = s.status === "canceled" ? "해지예정" : "구독중";
    else if (!subStatusById[s.user_id]) subStatusById[s.user_id] = "무료";
  });
  const lastSessionById = {};
  sessions.forEach(s => {
    if (!s.user_id) return;
    const t = new Date(s.created_at).getTime();
    if (!lastSessionById[s.user_id] || t > lastSessionById[s.user_id]) lastSessionById[s.user_id] = t;
  });
  const customers = profiles.map(u => {
    const ph = phoneById[u.id] || {};
    const last = lastSessionById[u.id];
    return {
      id: u.id,
      email: u.email || "",
      name: u.display_name || "",
      provider: providerById[u.id] || "email",
      joined: u.created_at || null,
      phone: ph.verified ? (ph.phone || "") : "",
      phoneVerified: !!ph.verified,
      marketing: !!ph.marketing_consent,
      sub: subStatusById[u.id] || "무료",
      sessions: sessMap[u.id] || 0,
      lastActive: last ? new Date(last).toISOString() : null,
    };
  }).sort((a, b) => new Date(b.joined || 0) - new Date(a.joined || 0));

  // ===== 탈퇴 통계 =====
  const del = deletions || [];
  const delTotal = del.length;
  const delAdmin = del.filter(d => d.kind === "admin").length;
  const delSelf = delTotal - delAdmin;
  const del30 = del.filter(d => (now - new Date(d.deleted_at).getTime()) <= 30 * 86400000).length;
  const delRange = del.filter(d => (d.deleted_at || "").slice(0, 10) >= winStart).length; // 선택 기간 내
  const delPaid = del.filter(d => d.had_paid).length;
  // 탈퇴율: 누적 가입(현재 회원수 + 탈퇴수) 대비 탈퇴 비율
  const cumSignups = profiles.length + delTotal;
  const churnRate = cumSignups ? +((delTotal / cumSignups) * 100).toFixed(1) : 0;
  // 평균 유지일
  const daysArr = del.map(d => (d.days_active == null ? null : +d.days_active)).filter(v => v != null && !isNaN(v));
  const avgDaysActive = daysArr.length ? Math.round(daysArr.reduce((a, b) => a + b, 0) / daysArr.length) : 0;
  // 사유 집계
  const reasonMap = {};
  del.forEach(d => { const r = (d.reason && d.reason.trim()) ? d.reason.trim() : "미기재"; reasonMap[r] = (reasonMap[r] || 0) + 1; });
  const reasons = Object.keys(reasonMap).map(r => ({ reason: r, count: reasonMap[r] })).sort((a, b) => b.count - a.count);
  const recentDeletions = del.slice(0, 30).map(d => ({ email: d.email || "", kind: d.kind || "self", reason: d.reason || "", days: d.days_active, paid: !!d.had_paid, openInquiry: !!d.open_inquiry, at: d.deleted_at }));
  const deletion = { total: delTotal, self: delSelf, admin: delAdmin, last30: del30, rangeCount: delRange, paid: delPaid, churnRate, cumSignups, avgDaysActive, reasons, recent: recentDeletions };

  return json({
    ok: true,
    kpi: {
      visitors, totalPageviews, avgDuration,
      payers, payCount: paid.length, payAmount,
      subscribers, activeSubs, totalUsers: profiles.length, totalSessions,
    },
    exitPages, perUser, revenueByDay, series, customers,
    inquiries: inquiries || [],
    promos: promos || [],
    adSpend, rangeDays: DAYS, rangePayers,
    stageCounts, periodVisitors,
    challengers, challenge,
    deletion,
  });
};
