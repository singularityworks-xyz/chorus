const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function parseTarget(data) {
  if (
    !data ||
    data.version !== 1 ||
    typeof data.boardId !== "string" ||
    typeof data.cardId !== "string" ||
    typeof data.boardTitle !== "string" ||
    typeof data.cardTitle !== "string" ||
    data.boardTitle.length > 160 ||
    data.cardTitle.length > 160 ||
    (data.requestId !== undefined &&
      (typeof data.requestId !== "string" || data.requestId.length > 256)) ||
    !["permission", "question"].includes(data.kind) ||
    !SAFE_ID.test(data.boardId) ||
    !SAFE_ID.test(data.cardId)
  ) {
    return null;
  }

  try {
    const target = new URL(data.url, self.location.origin);
    const boardIds = target.searchParams.getAll("board");
    const cardIds = target.searchParams.getAll("card");
    if (
      target.origin !== self.location.origin ||
      target.pathname !== "/" ||
      target.hash ||
      boardIds.length !== 1 ||
      cardIds.length !== 1 ||
      boardIds[0] !== data.boardId ||
      cardIds[0] !== data.cardId ||
      [...target.searchParams.keys()].some(
        (key) => key !== "board" && key !== "card"
      )
    ) {
      return null;
    }
    return target.href;
  } catch {
    return null;
  }
}

self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data?.json();
  } catch {
    return;
  }
  const url = parseTarget(data);
  if (!url) {
    return;
  }

  const title =
    data.kind === "permission"
      ? "Agent needs permission"
      : "Agent needs an answer";
  const body = `${data.cardTitle} · ${data.boardTitle}`;
  const tag = `chorus-approval-${data.boardId}-${data.cardId}-${data.requestId || data.kind}`;
  event.waitUntil(
    self.registration
      .showNotification(title, {
        body: body.slice(0, 320),
        data: {
          version: 1,
          boardId: data.boardId,
          cardId: data.cardId,
          boardTitle: data.boardTitle,
          cardTitle: data.cardTitle,
          kind: data.kind,
          requestId: data.requestId,
          url,
        },
        icon: "/chorus.svg",
        tag: tag.slice(0, 128),
        badge: "/chorus.svg",
        renotify: false,
      })
      .catch(() => undefined)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = parseTarget(event.notification.data);
  if (!target) {
    return;
  }
  event.waitUntil(
    self.clients
      .matchAll({ includeUncontrolled: true, type: "window" })
      .then(async (windows) => {
        for (const client of windows) {
          if (new URL(client.url).origin === self.location.origin) {
            try {
              const navigated = await client.navigate(target);
              if (navigated) {
                await navigated.focus();
                return;
              }
            } catch {
              // A tab may close between enumeration and navigation. Try the
              // next tab, then open a new one if none can reach the request.
            }
          }
        }
        await self.clients.openWindow(target);
      })
      .catch(() => undefined)
  );
});
