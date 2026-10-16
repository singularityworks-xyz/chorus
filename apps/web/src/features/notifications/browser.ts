const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IOS_USER_AGENT = /iPhone|iPad|iPod/i;

export const PUSH_RENEWAL_WINDOW_MS = 5 * 60 * 1000;

export function safeNotificationReturnTo(
  raw: string | null,
  origin: string
): string {
  if (!raw) {
    return "/";
  }
  try {
    const target = new URL(raw, origin);
    if (target.origin !== origin || target.pathname !== "/" || target.hash) {
      return "/";
    }
    const boards = target.searchParams.getAll("board");
    const cards = target.searchParams.getAll("card");
    if (
      boards.length !== 1 ||
      cards.length !== 1 ||
      !SAFE_ID.test(boards[0] ?? "") ||
      !SAFE_ID.test(cards[0] ?? "") ||
      [...target.searchParams.keys()].some(
        (key) => key !== "board" && key !== "card"
      )
    ) {
      return "/";
    }
    return `/?${new URLSearchParams({ board: boards[0] ?? "", card: cards[0] ?? "" })}`;
  } catch {
    return "/";
  }
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

export function pushSubscriptionNeedsRenewal(
  expirationTime: number | null,
  now = Date.now(),
  renewalWindowMs = PUSH_RENEWAL_WINDOW_MS
): boolean {
  return expirationTime !== null && expirationTime <= now + renewalWindowMs;
}

export function usesApplicationServerKey(
  subscriptionKey: ArrayBuffer | ArrayBufferView<ArrayBufferLike> | null,
  publicKey: string
): boolean {
  if (!subscriptionKey) {
    return false;
  }

  const actual = ArrayBuffer.isView(subscriptionKey)
    ? new Uint8Array(
        subscriptionKey.buffer,
        subscriptionKey.byteOffset,
        subscriptionKey.byteLength
      )
    : new Uint8Array(subscriptionKey);
  const expected = base64UrlToBytes(publicKey);
  return (
    actual.byteLength === expected.byteLength &&
    actual.every((byte, index) => byte === expected[index])
  );
}

export interface PushBrowserCapabilityInput {
  displayModeStandalone: boolean;
  maxTouchPoints: number;
  platform: string;
  pushManagerAvailable: boolean;
  secureContext: boolean;
  serviceWorkerAvailable: boolean;
  userAgent: string;
  vendorStandalone?: boolean;
}

export interface PushBrowserCapability {
  needsHomeScreen: boolean;
  supported: boolean;
}

export function getPushBrowserCapability(
  input: PushBrowserCapabilityInput
): PushBrowserCapability {
  const ios =
    IOS_USER_AGENT.test(input.userAgent) ||
    (input.platform === "MacIntel" && input.maxTouchPoints > 1);
  const standalone =
    input.displayModeStandalone || input.vendorStandalone === true;
  const needsHomeScreen = ios && !standalone;
  return {
    needsHomeScreen,
    supported:
      input.secureContext &&
      input.serviceWorkerAvailable &&
      input.pushManagerAvailable &&
      !needsHomeScreen,
  };
}
