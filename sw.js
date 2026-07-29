/* Minimal service worker for Sarvadharani Seeds Books.
   We deliberately DO NOT cache the HTML itself: Firestore is the
   source of truth and any hard-refresh must pull the latest UI.
   The SW exists only to make the browser treat this as an installable
   PWA and to survive offline navigations back to the app.
*/
const CACHE = 'sarvadharani-shell-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))));
    self.clients.claim();
});
self.addEventListener('fetch', (e) => {
    // Network-first for HTML so users always see the latest UI.
    if (e.request.mode === 'navigate') {
        e.respondWith(
            fetch(e.request).catch(() => caches.match(e.request).then(r => r || caches.match('./sarvadharani-earthy.html')))
        );
        return;
    }
    // Cache-first for static assets (SheetJS, fonts, gstatic firebase)
    e.respondWith(
        caches.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
            const copy = resp.clone();
            if (resp.ok && (e.request.url.startsWith('https://cdn.') || e.request.url.startsWith('https://fonts.') || e.request.url.startsWith('https://www.gstatic.com/'))) {
                caches.open(CACHE).then(c => c.put(e.request, copy));
            }
            return resp;
        }).catch(() => caches.match(e.request)))
    );
});
