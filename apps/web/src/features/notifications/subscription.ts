import type { PushConfigResponse } from "@chorus/contracts";
import {
  pushConfigResponseSchema,
  pushSubscriptionSchema,
} from "@chorus/contracts";
import {
  base64UrlToBytes,
  pushSubscriptionNeedsRenewal,
  usesApplicationServerKey,
} from "./browser";

const SUBSCRIPTION_LOCK = "chorus-push-subscription";
const OPT_IN_KEY = "chorus-push-opt-in:v1";
let fallbackSubscriptionLock: Promise<void> = Promise.resolve();

export function setPushOptIn(enabled: boolean): void {
  try {
    localStorage.setItem(OPT_IN_KEY, enabled ? "true" : "false");
  } catch {
    // Private browsing may disallow storage. Existing subscriptions still
    // establish opt-in for renewal during that session.
  }
}

function hasPushOptIn(): boolean {
  try {
    return localStorage.getItem(OPT_IN_KEY) === "true";
  } catch {
    return false;
  }
}

export function getPermission(): NotificationPermission | "unsupported" {
  return "Notification" in window
    ? window.Notification.permission
    : "unsupported";
}

async function fetchPushConfig(): Promise<PushConfigResponse> {
  const deviceResponse = await fetch("/api/auth/device", {
    credentials: "same-origin",
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  if (!deviceResponse.ok) {
    throw new Error(
      deviceResponse.status === 401
        ? "Sign in again to manage notifications."
        : "This browser could not register its notification identity."
    );
  }

  const response = await fetch("/api/auth/push-config", {
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "Sign in again to manage notifications."
        : "Notification settings are unavailable."
    );
  }
  const body: unknown = await response.json();
  return pushConfigResponseSchema.parse(body);
}

async function saveSubscription(
  subscription: PushSubscription
): Promise<boolean> {
  const parsed = pushSubscriptionSchema.safeParse(subscription.toJSON());
  if (!parsed.success) {
    return false;
  }
  const response = await fetch("/api/auth/push-subscriptions", {
    body: JSON.stringify(parsed.data),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  return response.ok;
}

export async function removeServerSubscription(
  endpoint: string
): Promise<boolean> {
  const response = await fetch("/api/auth/push-subscriptions", {
    body: JSON.stringify({ endpoint }),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    method: "DELETE",
    signal: AbortSignal.timeout(5000),
  });
  return response.ok;
}

export function withSubscriptionLock<T>(
  operation: () => Promise<T>
): Promise<T> {
  // Web Locks serialize resubscription across Chorus tabs. Older browsers still
  // get the same-tab guard from PushManager itself and can continue using push.
  if ("locks" in navigator) {
    return navigator.locks.request(SUBSCRIPTION_LOCK, operation);
  }
  const result = fallbackSubscriptionLock.then(operation, operation);
  fallbackSubscriptionLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export function runReconciliationInBackground(
  reconcile: () => Promise<boolean>
): void {
  reconcile().catch(() => undefined);
}

export function requestBrowserPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (!("Notification" in window && "serviceWorker" in navigator)) {
    return Promise.resolve("unsupported");
  }
  return window.Notification.requestPermission();
}

export function permissionMessage(
  access: NotificationPermission | "unsupported"
): string {
  if (access === "denied") {
    return "Notifications are blocked in browser settings.";
  }
  if (access === "unsupported") {
    return "This browser does not support push notifications.";
  }
  return "Allow notifications to receive approval requests.";
}

export interface ReconciliationResult {
  enabledByServer?: boolean;
  message: string | null;
  permission?: NotificationPermission | "unsupported";
  state: "active" | "ready" | "unavailable";
  subscription: PushSubscription | null;
}

type ExistingSubscriptionResult =
  | { kind: "active"; subscription: PushSubscription }
  | { kind: "replace"; subscription: null }
  | {
      kind: "error";
      message: string;
      subscription: PushSubscription | null;
    };

async function reconcileExistingSubscription(
  current: PushSubscription,
  publicKey: string
): Promise<ExistingSubscriptionResult> {
  let remaining: PushSubscription | null = current;
  try {
    const keyChanged = !usesApplicationServerKey(
      current.options.applicationServerKey,
      publicKey
    );
    const expiring = pushSubscriptionNeedsRenewal(current.expirationTime);
    if (!(keyChanged || expiring)) {
      if (!(await saveSubscription(current))) {
        return {
          kind: "error",
          message:
            "This browser’s notification subscription could not be synced.",
          subscription: current,
        };
      }
      return { kind: "active", subscription: current };
    }

    if (!(await current.unsubscribe())) {
      return {
        kind: "error",
        message:
          "The browser could not release its old notification subscription.",
        subscription: current,
      };
    }
    remaining = null;
    if (!(await removeServerSubscription(current.endpoint))) {
      return {
        kind: "error",
        message: "Chorus could not remove the old subscription before renewal.",
        subscription: null,
      };
    }
    return { kind: "replace", subscription: null };
  } catch (error) {
    return {
      kind: "error",
      message:
        error instanceof Error
          ? error.message
          : "Could not renew this browser’s notification subscription.",
      subscription: remaining,
    };
  }
}

async function createPushSubscription(
  registration: ServiceWorkerRegistration | undefined,
  publicKey: string
): Promise<PushSubscription> {
  const activeRegistration =
    registration ??
    (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
  await navigator.serviceWorker.ready;
  const next = await activeRegistration.pushManager.subscribe({
    applicationServerKey: base64UrlToBytes(publicKey),
    userVisibleOnly: true,
  });
  try {
    if (!(await saveSubscription(next))) {
      throw new Error("Chorus could not save this browser’s subscription.");
    }
    return next;
  } catch (error) {
    await next.unsubscribe().catch(() => false);
    throw error;
  }
}

export async function reconcilePushSubscription(
  allowCreate: boolean
): Promise<ReconciliationResult> {
  let observed: PushSubscription | null = null;
  let enabledByServer: boolean | undefined;
  let currentPermission: NotificationPermission | "unsupported" = "unsupported";
  try {
    if (
      !(
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window
      )
    ) {
      return {
        message: "This browser does not support push notifications.",
        permission: "unsupported",
        state: "unavailable",
        subscription: null,
      };
    }

    const config = await fetchPushConfig();
    enabledByServer = config.enabled && config.publicKey !== null;
    currentPermission = getPermission();
    const registration = await navigator.serviceWorker.getRegistration("/");
    observed = (await registration?.pushManager.getSubscription()) ?? null;
    if ((observed || allowCreate) && currentPermission === "granted") {
      setPushOptIn(true);
    }
    return reconcileConfiguredSubscription({
      allowCreate: allowCreate || hasPushOptIn(),
      enabledByServer,
      hadSubscription: observed !== null,
      permission: currentPermission,
      publicKey: config.publicKey,
      registration,
      subscription: observed,
    });
  } catch (error) {
    return {
      ...(enabledByServer !== undefined && { enabledByServer }),
      message:
        error instanceof Error
          ? error.message
          : "Could not reach notification settings.",
      permission: currentPermission,
      state: "ready",
      subscription: observed,
    };
  }
}

function readyResult(
  enabledByServer: boolean,
  permission: NotificationPermission | "unsupported",
  subscription: PushSubscription | null,
  message: string | null
): ReconciliationResult {
  return {
    enabledByServer,
    message,
    permission,
    state: "ready",
    subscription,
  };
}

async function reconcileDeniedPermission(
  subscription: PushSubscription | null,
  enabledByServer: boolean
): Promise<ReconciliationResult> {
  setPushOptIn(false);
  let remaining = subscription;
  if (subscription) {
    if (await subscription.unsubscribe().catch(() => false)) {
      remaining = null;
    }
    await removeServerSubscription(subscription.endpoint).catch(() => false);
  }
  return readyResult(
    enabledByServer,
    "denied",
    remaining,
    permissionMessage("denied")
  );
}

async function reconcileGrantedOrDefaultPermission(input: {
  allowCreate: boolean;
  enabledByServer: boolean;
  hadSubscription: boolean;
  permission: NotificationPermission | "unsupported";
  publicKey: string;
  registration: ServiceWorkerRegistration | undefined;
  subscription: PushSubscription | null;
}): Promise<ReconciliationResult> {
  let observed = input.subscription;
  if (input.permission === "granted" && observed) {
    const existing = await reconcileExistingSubscription(
      observed,
      input.publicKey
    );
    observed = existing.subscription;
    if (existing.kind === "active") {
      return {
        enabledByServer: input.enabledByServer,
        message: null,
        permission: input.permission,
        state: "active",
        subscription: observed,
      };
    }
    if (existing.kind === "error") {
      return readyResult(
        input.enabledByServer,
        input.permission,
        observed,
        existing.message
      );
    }
  }

  if (
    input.permission === "granted" &&
    (input.allowCreate || input.hadSubscription)
  ) {
    try {
      observed = await createPushSubscription(
        input.registration,
        input.publicKey
      );
      return {
        enabledByServer: input.enabledByServer,
        message: "This browser will receive approval requests.",
        permission: input.permission,
        state: "active",
        subscription: observed,
      };
    } catch (error) {
      return readyResult(
        input.enabledByServer,
        input.permission,
        observed,
        error instanceof Error
          ? error.message
          : "Could not create this browser’s notification subscription."
      );
    }
  }

  return readyResult(
    input.enabledByServer,
    input.permission,
    observed,
    input.permission === "default" ? permissionMessage(input.permission) : null
  );
}

function reconcileConfiguredSubscription(input: {
  allowCreate: boolean;
  enabledByServer: boolean;
  hadSubscription: boolean;
  permission: NotificationPermission | "unsupported";
  publicKey: string | null;
  registration: ServiceWorkerRegistration | undefined;
  subscription: PushSubscription | null;
}): Promise<ReconciliationResult> {
  if (input.permission === "denied") {
    return reconcileDeniedPermission(input.subscription, input.enabledByServer);
  }
  if (!(input.enabledByServer && input.publicKey)) {
    return Promise.resolve(
      readyResult(
        input.enabledByServer,
        input.permission,
        input.subscription,
        "Push is disabled by the server."
      )
    );
  }
  return reconcileGrantedOrDefaultPermission({
    ...input,
    publicKey: input.publicKey,
  });
}
