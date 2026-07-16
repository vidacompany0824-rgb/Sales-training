// netlify/functions/sales-coach.mjs
// 실시간 AI 롤플레이 백엔드 — 앱이 만든 prompt를 Claude(Anthropic)에 전달하고 응답을 반환.
// 이 함수가 있어야 "실제 AI"로 대화가 돌아갑니다. (없으면 앱은 데모 모드로 폴백)
//
// 요청(JSON POST): { prompt }   ← 프론트가 페르소나 지시 + 대화기록 + 출력형식을 담아 보냄
// 응답(JSON): { text }          ← Claude가 생성한 텍스트(내부에 JSON 한 덩어리). 앱이 파싱함.
//
// 필요한 Netlify 환경변수:
//   ANTHROPIC_API_KEY  (필수)  — console.anthropic.com 에서 발급한 API 키
//   CLAUDE_MODEL       (선택)  — 기본 "claude-sonnet-5". 비용을 아끼려면 "claude-haiku-4-5-20251001"

function json(o, s) {
  return new Response(JSON.stringify(o), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const KEY = process.env.ANTHROPIC_API_KEY;
  const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
  if (!KEY) return json({ error: "server_env_missing" }, 500);

  let body = {};
  try { body = await req.json(); } catch (_) {}
  const prompt = body.prompt;
  if (!prompt) return json({ error: "missing_prompt" }, 400);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "anthropic_error", detail: j }, 502);
    const text = (j.content && j.content[0] && j.content[0].text) || "";
    return json({ text });
  } catch (e) {
    return json({ error: "proxy_error", message: String(e) }, 502);
  }
};
