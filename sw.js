/* BETR service worker.

   Deliberately stupid, and it has to stay that way. A service worker
   updates on the browser's schedule rather than yours — checked on
   navigation, and not more than once a day — so anything wrong in here
   is slow to fix in a way a wrong line in index.html is not. One cache,
   one strategy, nothing clever. Every decision the app makes lives in
   the page, which updates normally.

   Network first, not cache first. Cache first is the usual default and
   it is the wrong one here: it serves the old copy and checks for a new
   one afterwards, which turns a few minutes of CDN lag into a day of
   running yesterday's build. This asks the network every time and only
   reaches for the cache when the network does not answer.

   The timeout is the part that matters on a plane. Wifi that is
   connected but has no route — a captive portal, or a pass you have not
   bought yet — does not fail, it hangs. Without a deadline the app
   would sit on a white screen until the request gave up on its own. */

const CACHE = 'betr-page';
const DEADLINE = 2500;
const PAGE = './index.html';

self.addEventListener('install', e => {
  /* Precached here rather than on first fetch, so the app is armed the
     moment the worker installs rather than the next time it happens to
     be opened online. waitUntil holds the install open until this
     finishes: if it fails the worker never activates, which is the
     honest outcome — no offline copy at all beats a half-made one. */
  e.waitUntil(
    caches.open(CACHE)
      /* cache:'reload' matters more than it looks. addAll fetches
         through the browser's own HTTP cache, so a precache can quietly
         re-store the stale copy you were trying to escape — which is
         the exact failure this whole thing exists to avoid. This forces
         it past that cache to the network. */
      .then(c => c.addAll([
        new Request(PAGE, {cache: 'reload'}),
        new Request('./', {cache: 'reload'}),
      ]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* The page asks for this on load to find out whether what it is running
   came off the network or out of the cache — navigator.onLine cannot
   tell it, because a dead connection still reports as online. */
let servedFrom = 'network';

self.addEventListener('message', e => {
  if (e.data === 'whence' && e.source) e.source.postMessage({ servedFrom });
  if (e.data === 'drop') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister());
  }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(networkFirst(req));
});

function withDeadline(p, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('slow')), ms);
    p.then(v => { clearTimeout(t); res(v); },
           err => { clearTimeout(t); rej(err); });
  });
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await withDeadline(fetch(req), DEADLINE);
    /* Only a real answer is worth keeping. A 404 page cached as the app
       would be worse than no cache at all. */
    if (fresh && fresh.ok) {
      servedFrom = 'network';
      cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    }
    throw new Error('bad status');
  } catch (err) {
    const hit = await cache.match(req) ||
                await cache.match(PAGE) ||
                await cache.match('./');
    if (hit) { servedFrom = 'cache'; return hit; }
    throw err;
  }
}
