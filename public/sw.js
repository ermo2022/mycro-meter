const CACHE_PREFIX = 'mycrometer-shell-'
const CACHE_NAME = `${CACHE_PREFIX}v2`
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './mycrometer.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      try {
        const response = await fetch(event.request)
        if (response.ok) {
          await cache.put(event.request, response.clone())
        }
        return response
      } catch {
        const cached = await cache.match(event.request)
        return cached ?? (event.request.mode === 'navigate' ? cache.match('./index.html') : Response.error())
      }
    })(),
  )
})
