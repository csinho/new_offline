const CACHE = "bovichain-offline-v4";
const SHELL = [
    "./",
    "./index.html",
    "./app.js",
    "./idb.js",
    "./manifest.json"
];

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches.open(CACHE).then((c) => c.addAll(SHELL))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))))
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (e) => {
    const req = e.request;
    const url = new URL(req.url);

    // 1) Navegação (HTML): SEMPRE devolve o index.html do cache quando offline
    if (req.mode === "navigate") {
        e.respondWith(
            fetch(req).catch(async () => {
                const cache = await caches.open(CACHE);
                return cache.match("./index.html");
            })
        );
        return;
    }

    // 2) Arquivos do mesmo domínio: cache-first
    if (url.origin === location.origin) {
        e.respondWith(
            caches.match(req).then(async (cached) => {
                if (cached) return cached;

                const res = await fetch(req);
                const copy = res.clone();
                const cache = await caches.open(CACHE);
                cache.put(req, copy);
                return res;
            }).catch(async () => {
                // fallback opcional
                const cache = await caches.open(CACHE);
                return cache.match(req);
            })
        );
    }
});
