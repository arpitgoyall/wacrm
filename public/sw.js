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
  const isMessage = data.type === "new_message" && !!data.conversationId;

  const options = {
    body: data.body || "",
    icon: data.icon || "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "wacrm",
    renotify: true,
    vibrate: [80, 40, 80],
    timestamp: Date.now(),
    data: {
      url: data.url || "/notifications",
      conversationId: data.conversationId || null,
      type: data.type || null,
    },
    // WhatsApp-style inline actions. Android renders these; iOS ignores
    // them harmlessly.
    actions: isMessage
      ? [
          { action: "reply", type: "text", title: "Reply", placeholder: "Reply" },
          { action: "mark-read", title: "Mark as read" },
        ]
      : [],
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
  const notification = event.notification;
  const data = notification.data || {};
  const conversationId = data.conversationId;

  // Inline "Reply" — send the typed text through the dashboard's own
  // send endpoint (the SW request carries the session cookie).
  if (event.action === "reply") {
    const text = (event.reply || "").trim();
    if (!text || !conversationId) {
      notification.close();
      return;
    }
    event.waitUntil(
      fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          conversation_id: conversationId,
          message_type: "text",
          content_text: text,
        }),
      })
        .then((res) => {
          if (res.ok) {
            notification.close();
            return undefined;
          }
          return self.registration.showNotification("Couldn't send reply", {
            body: "Open the app to try again.",
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            tag: notification.tag,
          });
        })
        .catch(() =>
          self.registration.showNotification("Couldn't send reply", {
            body: "You appear to be offline.",
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            tag: notification.tag,
          }),
        ),
    );
    return;
  }

  // "Mark as read" — clear this chat's notification-centre entries
  // without opening the app.
  if (event.action === "mark-read") {
    notification.close();
    if (!conversationId) return;
    event.waitUntil(
      fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ conversation_id: conversationId }),
      }).catch(() => undefined),
    );
    return;
  }

  // Body tap — open the conversation.
  notification.close();
  const targetUrl = new URL(
    data.url || "/inbox",
    self.location.origin,
  ).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existingClient = clients.find((client) => "focus" in client);
        if (existingClient) {
          return existingClient
            .navigate(targetUrl)
            .then((client) => client && client.focus());
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