// ツボマップ3D：オフライン用のキャッシュ（build.py が生成）
const CACHE = 'tsubomap3d-f39dd2df7faf';
const ASSETS = ["./", "index.html", "app.js", "config.js", "backend-firebase.js", "lib/three.module.min.js", "lib/OrbitControls.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "models/skin.bin", "models/muscle.bin", "models/bone.bin", "models/skin_parts.bin"];
const SDK = ["https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js", "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js", "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js"];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.concat(SDK))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('tsubomap3d-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || (new URL(req.url).origin !== location.origin && SDK.indexOf(req.url) < 0)) return;      // ログインやツボのやり取り（通信）には手を出さない
  if (req.mode === 'navigate') {            // 画面本体：つながっていれば新しいものを、なければ保存したものを
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));   // 部品・モデル：保存したものを優先
});
