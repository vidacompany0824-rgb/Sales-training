// netlify/functions/admin-promo.mjs
// 어드민 전용 · 프로모션 코드 생성/수정/토글
//
// 요청(JSON POST): { accessToken, action, ... }
//   action="create" : { code, discount_type('percent'|'fixed'), discount_value, max_uses?, expires_at?, note? }
//   action="toggle" : { id, active }
//   action="delete" : { id }
//
// 필요한 Netlify 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
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

  const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
  const action = body.action;

  try {
    if (action === "create") {
      const code = String(body.code || "").trim().toUpperCase();
      const type = body.discount_type === "fixed" ? "fixed" : "percent";
      let value = Math.round(Number(body.discount_value) || 0);
      if (!code) return json({ error: "code_required" }, 400);
      if (value < 0) value = 0;
      if (type === "percent" && value > 100) value = 100;
      const rec = {
        code, discount_type: type, discount_value: value,
        active: true,
        max_uses: (body.max_uses === "" || body.max_uses == null) ? null : Math.max(1, Math.round(Number(body.max_uses))),
        expires_at: body.expires_at ? new Date(body.expires_at).toISOString() : null,
        note: body.note ? String(body.note).slice(0, 120) : null,
      };
      const r = await fetch(`${SUPA}/rest/v1/promo_codes`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(rec) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const dup = (d && (d.code === "23505" || String(d.message || "").includes("duplicate")));
        return json({ error: dup ? "code_exists" : "db_error", detail: d }, dup ? 409 : 500);
      }
      return json({ ok: true, row: Array.isArray(d) ? d[0] : d });
    }

    if (action === "toggle") {
      if (!body.id) return json({ error: "id_required" }, 400);
      const r = await fetch(`${SUPA}/rest/v1/promo_codes?id=eq.${encodeURIComponent(body.id)}`, {
        method: "PATCH", headers: H, body: JSON.stringify({ active: !!body.active }),
      });
      if (!r.ok) return json({ error: "db_error", detail: await r.text() }, 500);
      return json({ ok: true });
    }

    if (action === "delete") {
      if (!body.id) return json({ error: "id_required" }, 400);
      const r = await fetch(`${SUPA}/rest/v1/promo_codes?id=eq.${encodeURIComponent(body.id)}`, { method: "DELETE", headers: H });
      if (!r.ok) return json({ error: "db_error", detail: await r.text() }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: "server_error", message: String(e) }, 500);
  }
};
