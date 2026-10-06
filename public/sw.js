// PacedMind's service worker, for notifications only (src/server/push.ts sends them, Settings turns them on). It shows
// what a push says, and a tap opens that session in the app: a path on this site, never another address.

// The app records this browser's language without changing account or subscription data.
self.addEventListener("message", (event) => {
  if (event.data?.kind !== "pacedmind-language" || !["en", "pl"].includes(event.data.language)) return;
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  event.waitUntil(caches.open("pacedmind-language").then((cache) => cache.put("/__pacedmind-language", new Response(event.data.language))));
});
async function notificationTitle(title) {
  const language = await caches.open("pacedmind-language").then((cache) => cache.match("/__pacedmind-language")).then((value) => value?.text()).catch(() => "en");
  if (language !== "pl") return title;
  const phrases = {
    "asks for your permission": "prosi o zgodę", "has a question for you": "ma pytanie do Ciebie",
    "is waiting for you": "czeka na Ciebie", "stopped at a usage limit": "wstrzymano po osiągnięciu limitu",
    "is blocked": "jest zablokowane", "is partly done": "jest częściowo wykonane", "is finished": "jest ukończone",
    "Asks your permission": "Prosi o zgodę", "Waiting for you": "Czeka na Ciebie", "Has a question": "Ma pytanie",
    "Paused: usage limit": "Wstrzymano: limit użycia", "Paused: model at capacity": "Wstrzymano: model jest przeciążony",
    "Conversation open elsewhere": "Rozmowa otwarta gdzie indziej", "Paused: agent error": "Wstrzymano: błąd agenta",
    "Check agent startup": "Sprawdź uruchamianie agenta", "Send the first message": "Wyślij pierwszą wiadomość",
  };
  for (const [phrase, translation] of Object.entries(phrases)) {
    if (title.endsWith(" " + phrase)) return title.slice(0, -phrase.length) + translation;
  }
  return title;
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not what PacedMind sends: show a plain notification.
  }
  const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  event.waitUntil(
    notificationTitle(text(data.title, 120) || "PacedMind").then((title) => self.registration.showNotification(title, {
      body: text(data.body, 300),
      tag: text(data.tag, 60) || undefined,
      renotify: !!data.tag,
      icon: "/brand/pacedmind-emblem.png",
      badge: "/brand/pacedmind-emblem.png",
      data: { path: text(data.path, 200) },
    })),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data && event.notification.data.path;
  const safe = typeof path === "string" && /^\/(?!\/)[\w\-./?=&%]*$/.test(path) ? path : "/sessions";
  const url = new URL(safe, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          return w.navigate(url).then((c) => (c || w).focus());
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
