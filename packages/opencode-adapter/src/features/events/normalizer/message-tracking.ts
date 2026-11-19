const assistantMessageIds = new Map<string, Set<string>>();

const MAX_TRACKED_MESSAGES_PER_SESSION = 512;
const MAX_TRACKED_SESSIONS = 4096;

function sessionKey(scope: string, sessionID: string): string {
  return `${scope}\0${sessionID}`;
}

export function hasAssistantMessage(
  scope: string,
  sessionID: string,
  messageID: string
): boolean {
  return (
    assistantMessageIds.get(sessionKey(scope, sessionID))?.has(messageID) ??
    false
  );
}

export function recordAssistantMessage(
  scope: string,
  sessionID: string,
  messageID: string
): void {
  const key = sessionKey(scope, sessionID);
  let messageIds = assistantMessageIds.get(key);
  if (messageIds) {
    assistantMessageIds.delete(key);
    assistantMessageIds.set(key, messageIds);
  } else {
    messageIds = new Set();
    if (assistantMessageIds.size >= MAX_TRACKED_SESSIONS) {
      const [oldest] = assistantMessageIds.keys();
      if (oldest) {
        assistantMessageIds.delete(oldest);
      }
    }
    assistantMessageIds.set(key, messageIds);
  }

  if (messageIds.size >= MAX_TRACKED_MESSAGES_PER_SESSION) {
    const [oldest] = messageIds.values();
    if (oldest) {
      messageIds.delete(oldest);
    }
  }

  messageIds.add(messageID);
}

export function resetMessageTracking(): void {
  assistantMessageIds.clear();
}
