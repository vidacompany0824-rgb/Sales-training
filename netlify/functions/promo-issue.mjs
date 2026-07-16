// netlify/functions/promo-issue.mjs
// 공개 엔드포인트 · 인스타 DM 유입용 "1회용 고유 프로모 코드" 즉석 발급
//
// 흐름: 인스타 DM 버튼 링크(앱주소/?promo=1)로 들어온 사람이 앱을 열면
//       프론트가 이 함수를 호출 → 여기서 promo_codes 테이블에 max_uses=1,
//       active=true, 만료일이 지정된 "고유 코드"를 1건 생성 → 코드 문자열을 반환.
//       이후 검증/적용은 기존 preview_promo(RPC) 와 subscribe.mjs 가 그대로 처리.
//       (테이블/스키마 변경 없음 · source 는 note 컬럼에 기록)
//
// 요청(JSON POST): { source? }        // source 예: "instagram"
// 응답: { ok:true, code:"IG7K3P9Q", discount_type, discount_value, expires_at }
//
// 필요한 Netlify 환경변수:
//   SUPABASE_URL                 (필수)
//   SUPABASE_SERVICE_ROLE_KEY    (필수)
//   PROMO_IG_TYPE        = 'percent' | 'fixed'   (기본 'percent')
//   PROMO_IG_VALUE       = 20                     (percent면 %, fixed면 원 · 기본 20)
//   PROMO_IG_EXPIRE_DAYS = 7                      (발급 후 유효기간(일) · 기본 7)
//   PROMO_IG_PREFIX      = 'IG'                   (코드 접두사 · 기본 'IG')
//   PROMO_ALLOWED_ORIGIN = https://내앱주소       (선택: 지정 시 해당 Origin 요청만 허용)

import { webcrypto } from "node:crypto";
const CRYPTO = globalThis.crypto || webcrypto;

function json(o, s) {
  return new Response(JSON.stringify(o), {
    status: s || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// 헷갈리는 문자(0/O, 1/I) 제외 — 사람이 눈으로 봐도 안 헷갈리는 코드
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function randCode(prefix, len) {
  const buf = new Uint32Array(len);
  CRYPTO.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return prefix + s;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const SUPA = process.env.SUPABASE_URL;
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPA || !SERVICE) return json({ error: "server_env_missing" }, 500);

  // (선택) Origin 제한 — 무분별한 외부 호출 차단
  const allow = (process.env.PROMO_ALLOWED_ORIGIN || "").trim();
  if (allow) {
    const origin = req.headers.get("origin") || req.headers.get("referer") || "";
    if (origin && origin.indexOf(allow) !== 0) return json({ error: "forbidden_origin" }, 403);
  }

  let body = {};
  try { body = await req.json(); } catch (_) {}
  const source = String(body.source || "instagram").slice(0, 30);

  // 할인 조건 (환경변수로 조정 · 코드 수정 없이 변경 가능)
  const type = process.env.PROMO_IG_TYPE === "fixed" ? "fixed" : "percent";
  let value = Math.round(Number(process.env.PROMO_IG_VALUE || 20));
  if (value < 0) value = 0;
  if (type === "percent" && value > 100) value = 100;
  const days = Math.max(1, Math.round(Number(process.env.PROMO_IG_EXPIRE_DAYS || 7)));
  const prefix = (process.env.PROMO_IG_PREFIX || "IG").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "IG";
  const expires_at = new Date(Date.now() + days * 86400000).toISOString();

  const H = {
    apikey: SERVICE,
    Authorization: `Bearer ${SERVICE}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  // 고유 코드 생성 — 유니크 충돌 시 최대 5회 재시도
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randCode(prefix, 6);
    const rec = {
      code,
      discount_type: type,
      discount_value: value,
      active: true,
      max_uses: 1,          // 1회용
      expires_at,
      note: `자동발급 · ${source}`,
    };
    try {
      const r = await fetch(`${SUPA}/rest/v1/promo_codes`, { method: "POST", headers: H, body: JSON.stringify(rec) });
      if (r.ok) {
        const d = await r.json().catch(() => []);
        const row = Array.isArray(d) ? d[0] : d;
        return json({ ok: true, code: (row && row.code) || code, discount_type: type, discount_value: value, expires_at });
      }
      const d = await r.json().catch(() => ({}));
      const dup = d && (d.code === "23505" || String(d.message || "").includes("duplicate"));
      if (!dup) return json({ error: "db_error", detail: d }, 500);
      // 중복이면 다른 코드로 재시도
    } catch (e) {
      return json({ error: "server_error", message: String(e) }, 500);
    }
  }
  return json({ error: "code_gen_failed" }, 500);
};
