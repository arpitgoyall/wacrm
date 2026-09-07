const CACHE_NAME = "wacrm-static-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("wacrm-static-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || "New notification";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "wacrm",
    renotify: true,
    vibrate: [80, 40, 80],
    data: { url: data.url || "/notifications" },
  };

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // A focused, visible app tab already shows the in-app toast +
        // plays the chime — don't double up with an OS notification.
        const appFocused = clients.some(
          (c) => c.visibilityState === "visible" && c.focused,
        );
        if (appFocused) return undefined;
        return self.registration.showNotification(title, options);
      }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(
    event.notification.data?.url || "/inbox",
    self.location.origin,
  ).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existingClient = clients.find((client) => "focus" in client);
      if (existingClient) {
        return existingClient.navigate(targetUrl).then((client) => client?.focus());
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    (!url.pathname.startsWith("/_next/static/") &&
      !url.pathname.startsWith("/icons/"))
  ) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });

      return cached || network;
    }),
  );
});