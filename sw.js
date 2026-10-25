// Service worker: l'app si apre anche senza rete e si aggiorna da sola.
const CACHE = 'spesefam-v1';
const CORE = ['./', './assets/merge.js', './assets/dc-runtime.js', './assets/react.production.min.js',
  './assets/react-dom.production.min.js', './assets/babel.min.js', './assets/material-symbols-rounded.woff2',
  './assets/jakarta-latin.woff2', './assets/jakarta-latinext.woff2', './manifest.webmanifest', './icons/apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/api/')) return; // i dati passano sempre dalla rete
  const base = new URL('./', self.registration.scope).pathname;
  // pagina e logica di unione: prima la rete (cosi' gli aggiornamenti arrivano subito), poi la copia locale
  const networkFirst = req.mode === 'navigate' || url.pathname === base || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/assets/merge.js');
  if (networkFirst) {
    const key = req.mode === 'navigate' ? base : req;
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(key, cp)); } return r; })
      .catch(() => caches.match(key)));
  } else {
    // librerie e caratteri: non cambiano, si usa la copia locale (apertura veloce)
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); } return r; })));
  }
});
