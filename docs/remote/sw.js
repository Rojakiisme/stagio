// Keeps the remote working without internet once it has been opened. With a connection the page
// and its files come fresh from the site (so a phone always has the newest page, which matters
// when Stagio changes how commands are sent), and the copy is kept; without one, or when the
// site doesn't answer within a few seconds, the kept copy is used.
const CACHE = 'stagio-bt-remote-v3';
const FILES = ['./', 'index.html', 'remote.js', 'remote.css', 'manifest.webmanifest', '../icons/favicon.png', '../icons/apple-touch-icon.png', '../icons/icon-192.png', '../icons/icon-512.png'];
const WAIT_MS = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const fresh = fetch(e.request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  });
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const kept = () => caches.match(e.request).then((hit) => { if (hit && !done) { done = true; resolve(hit); } return hit; });
    // No answer in time (a venue network without internet can hang): the kept copy, if any.
    const timer = setTimeout(kept, WAIT_MS);
    fresh.then((res) => { clearTimeout(timer); if (!done) { done = true; resolve(res); } })
      .catch(() => { clearTimeout(timer); kept().then((hit) => { if (!done) { done = true; resolve(hit || Response.error()); } }); });
  }));
});
