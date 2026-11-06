/* Service worker: keeps a copy of the app on the device so it OPENS with no internet.
   It never touches Supabase (other website): sales and reports are handled by the app itself.
   Strategy: page = network first (so updates arrive), falling back to the saved copy; /assets (named by content) = saved copy first. */
const CACHE = 'pos-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((u) => cache.add(u).catch(() => {})));
    // also fetch the files the page needs, so the very first offline start works
    try {
      const html = await (await cache.match('/index.html') || await cache.match('/'))?.text();
      const urls = [...(html || '').matchAll(/(?:src|href)="(\/[^"/][^"]*)"/g)].map((m) => m[1]).filter((u) => !SHELL.includes(u.split('?')[0]));
      await Promise.all(urls.map((u) => cache.add(u).catch(() => {})));
    } catch { /* ignore */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function cleanOldAssets(cache, html) {
  const keep = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]));
  if (!keep.size) return;
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(req);
  }
}

async function page(request) {
  const cache = await caches.open(CACHE);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    const copy = res.clone();
    const text = await copy.text();
    // only keep it if it really is our app (not a hotel wifi "please log in" page)
    if (res.ok && text.includes('id="root"')) {
      await cache.put('/index.html', new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
      await cleanOldAssets(cache, text);
    }
    return res;
  } catch {
    return (await cache.match('/index.html')) || (await cache.match('/')) || new Response('Offline and the app is not saved on this device yet. Open it once with internet.', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase and anything else: not ours to handle
  if (req.mode === 'navigate') { event.respondWith(page(req)); return; }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  // everything else from our own site (icons, the manifest, scripts that are not in /assets): saved copy now, refreshed in the background
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit || new Response('', { status: 504 }));
    return hit || fresh;
  })());
});
