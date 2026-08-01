const SW_VERSION = 'bingekeeper-sw-v16';
const CACHE_NAME = 'bingekeeper-pwa-v16';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js?v=push-audit-v1',
  '/manifest.webmanifest',
  '/images/logo.png',
  '/images/dashboard-preview.png',
  '/images/icons/icon-192.png',
  '/images/icons/icon-512.png',
  '/images/icons/maskable-192.png',
  '/images/icons/maskable-512.png',
  '/images/icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/') || caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      return response;
    }))
  );
});

self.addEventListener('push', event => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || 'BingeKeeper';
  const options = {
    body: data.body || 'A tracked show has a new update.',
    icon: '/images/icons/icon-192.png',
    badge: '/images/icons/icon-192.png',
    tag: data.test_id || data.episode_key || undefined,
    renotify: Boolean(data.test_id || data.episode_key),
    data: {
      url: data.url || '/',
      test_id: data.test_id || null,
      show_id: data.show_id || null,
      episode_key: data.episode_key || null
    }
  };

  event.waitUntil((async () => {
    const receivedAck = acknowledgePush(data.ack_token, 'received');
    await self.registration.showNotification(title, options);
    await Promise.all([receivedAck, acknowledgePush(data.ack_token, 'displayed')]);
  })());
});

async function acknowledgePush(token, stage) {
  if (!token) return;
  try {
    await fetch('/api/push/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, stage })
    });
  } catch {}
}

self.addEventListener('message', event => {
  if (event.data?.type !== 'GET_VERSION') return;
  event.ports?.[0]?.postMessage({
    type: 'SW_VERSION',
    version: SW_VERSION,
    cacheName: CACHE_NAME
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).toString();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client && new URL(client.url).origin === self.location.origin) {
          return client.navigate(targetUrl).then(() => client.focus());
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
      return undefined;
    })
  );
});
