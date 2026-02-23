const CACHE = "bovichain-offline-v6";
const SHELL = [
    "./",
    "./index.html",
    "./manifest.json",
    "./assets/css/style.css",
    "./assets/js/app.js",
    "./assets/js/idb.js",
    "./assets/js/config.js"
];

function isShellRequest(url) {
    const path = url.pathname;
    return path.endsWith("index.html") || path === "/" || path === "" ||
        path.endsWith("manifest.json") ||
        path.endsWith("style.css") ||
        path.endsWith("app.js") || path.endsWith("idb.js") || path.endsWith("config.js");
}

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches.open(CACHE).then((c) => c.addAll(SHELL))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k)))))
    );
    self.clients.claim();
});

self.addEventListener("fetch", (e) => {
    const req = e.request;
    const url = new URL(req.url);

    // 1) Navegação (HTML): rede primeiro (F5 traz versão nova); cache só quando offline
    if (req.mode === "navigate") {
        e.respondWith(
            fetch(req, { cache: "reload" })
                .then(async (res) => {
                    const cache = await caches.open(CACHE);
                    cache.put("./index.html", res.clone());
                    return res;
                })
                .catch(async () => {
                    const cache = await caches.open(CACHE);
                    return cache.match("./index.html") || cache.match("index.html");
                })
        );
        return;
    }

    // 2) Shell (index, css, js, manifest): rede primeiro quando online
    if (url.origin === location.origin && isShellRequest(url)) {
        e.respondWith(
            fetch(req, { cache: "reload" })
                .then(async (res) => {
                    const cache = await caches.open(CACHE);
                    cache.put(req, res.clone());
                    return res;
                })
                .catch(async () => {
                    const cache = await caches.open(CACHE);
                    return cache.match(req);
                })
        );
        return;
    }

    // 3) Outros arquivos do mesmo domínio: cache-first
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
                const cache = await caches.open(CACHE);
                return cache.match(req);
            })
        );
    }
});
