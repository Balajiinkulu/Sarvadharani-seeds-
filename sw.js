/* Service worker for Sarvadharani Seeds Books.

   Strategy, and why:

   The app used to be one big index.html, and this worker deliberately
   cached nothing local — the comment said "any hard-refresh must pull the
   latest UI". That intent is right, but it meant the offline fallback
   (caches.match('./index.html')) could never match anything, because
   index.html was never put in a cache. So opening the app with no signal
   showed a browser error page, not the app.

   Now that the app is split into index.html + app.js + styles.css +
   images, we can do better without giving up freshness:

     - Navigations and local app files: NETWORK FIRST. When there's a
       connection, the newest version always wins, so a deploy is picked
       up on the next load exactly as before. The cached copy is only
       ever used when the network actually fails.
     - Third-party libraries (Firebase, fonts, CDN): CACHE FIRST. These
       are versioned by URL and effectively immutable, so serving them
       from cache is both safe and much faster on a slow connection.

   Bump CACHE when the shell file list changes, so old entries are
   cleaned up by the activate handler below.
*/
const CACHE = 'sarvadharani-shell-v78';

const SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './logo.png',
  './logo-mark.png',
  './icon-192.png',
  './icon-512.png',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  // Pre-cache the shell so a cold start with no signal still opens the app.
  // Individual failures must not abort the whole install, hence the per-file
  // catch — a missing optional file shouldn't leave the app with no worker.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(
        SHELL.map(url => c.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Same-origin app files that must stay fresh whenever the network allows.
function isLocalAppFile(url) {
  return url.origin === self.location.origin &&
         /\.(?:js|css|png|json)$/i.test(url.pathname);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Only GETs are cacheable; let anything else (e.g. Firestore writes)
  // go straight to the network untouched.
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }

  // Network-first for page loads, with the cached shell as the offline
  // fallback so the app still opens with no signal.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
          return resp;
        })
        .catch(() =>
          caches.match(req).then(hit => hit || caches.match('./index.html'))
        )
    );
    return;
  }

  // Network-first for our own JS/CSS/images, so a new deploy is always
  // picked up when online, and the last good copy is used when offline.
  if (isLocalAppFile(url)) {
    e.respondWith(
      fetch(req)
        .then(resp => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return resp;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for immutable third-party assets (CDN, fonts, Firebase).
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      const copy = resp.clone();
      if (resp.ok && (
            req.url.startsWith('https://cdn.') ||
            req.url.startsWith('https://cdnjs.') ||
            req.url.startsWith('https://fonts.') ||
            req.url.startsWith('https://www.gstatic.com/')
          )) {
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return resp;
    }).catch(() => caches.match(req)))
  );
});
