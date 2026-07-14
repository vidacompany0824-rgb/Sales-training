/* 세일즈 훈련 PWA · 서비스 워커
   - 앱 셸(HTML·아이콘)만 캐시해 오프라인/재방문 로딩을 빠르게.
   - Supabase·포트원·Netlify 함수 등 동적/외부 호출은 캐시하지 않음(항상 네트워크).
   앱을 새로 배포하면 CACHE 버전을 올려주세요(예: v1 → v2). */
const CACHE = "ssukssuk-v3";
const ASSETS = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // POST 등 API 호출은 통과
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;        // 외부(CDN·Supabase·포트원)는 캐시 안 함
  if (url.pathname.indexOf("/.netlify/") >= 0) return; // 백엔드 함수는 항상 네트워크

  // 앱 셸: 네트워크 우선 → 실패 시 캐시 → 없으면 index
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match("./index.html")))
  );
});
