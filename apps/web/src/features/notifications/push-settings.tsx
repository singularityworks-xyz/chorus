"use client";
import { BellOffIcon, BellRingIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getPushBrowserCapability, PUSH_RENEWAL_WINDOW_MS } from "./browser";
import {
  getPermission,
  permissionMessage,
  type ReconciliationResult,
  reconcilePushSubscription,
  removeServerSubscription,
  requestBrowserPermission,
  runReconciliationInBackground,
  setPushOptIn,
  withSubscriptionLock,
} from "./subscription";

type PushState = "loading" | "ready" | "active" | "busy" | "unavailable";
const MAX_TIMER_MS = 2_147_000_000;
export function PushSettings() {
  const [state, setState] = useState<PushState>("loading");
  const [enabledByServer, setEnabledByServer] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscription | null>(
    null
  );
  const [supported, setSupported] = useState(false);
  const [needsHomeScreen, setNeedsHomeScreen] = useState(false);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >(typeof window === "undefined" ? "unsupported" : "default");
  const [message, setMessage] = useState<string | null>(null);

  const reconcile = useCallback(async (allowCreate = false) => {
    const result = await withSubscriptionLock(() =>
      reconcilePushSubscription(allowCreate)
    ).catch(
      (error): ReconciliationResult => ({
        message:
          error instanceof Error
            ? error.message
            : "Could not synchronize notification settings.",
        permission: getPermission(),
        state: "ready",
        subscription: null,
      })
    );
    if (result.enabledByServer !== undefined) {
      setEnabledByServer(result.enabledByServer);
    }
    if (result.permission !== undefined) {
      setPermission(result.permission);
    }
    setSubscription(result.subscription);
    setState(result.state);
    setMessage(result.message);
    return result.state === "active";
  }, []);

  useEffect(() => {
    const capability = getPushBrowserCapability({
      displayModeStandalone: window.matchMedia("(display-mode: standalone)")
        .matches,
      maxTouchPoints: navigator.maxTouchPoints,
      platform: navigator.platform,
      pushManagerAvailable: "PushManager" in window,
      secureContext: window.isSecureContext,
      serviceWorkerAvailable: "serviceWorker" in navigator,
      userAgent: navigator.userAgent,
      vendorStandalone:
        "standalone" in navigator &&
        (navigator as Navigator & { standalone?: boolean }).standalone === true,
    });
    setSupported(capability.supported);
    setNeedsHomeScreen(capability.needsHomeScreen);
    setPermission(getPermission());
    runReconciliationInBackground(reconcile);

    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") {
        runReconciliationInBackground(reconcile);
      }
    };
    const refreshAfterWorkerActivation = () =>
      runReconciliationInBackground(reconcile);
    document.addEventListener("visibilitychange", refreshOnReturn);
    navigator.serviceWorker?.addEventListener(
      "controllerchange",
      refreshAfterWorkerActivation
    );
    return () => {
      document.removeEventListener("visibilitychange", refreshOnReturn);
      navigator.serviceWorker?.removeEventListener(
        "controllerchange",
        refreshAfterWorkerActivation
      );
    };
  }, [reconcile]);

  useEffect(() => {
    if (state !== "active" || subscription?.expirationTime == null) {
      return;
    }
    const delay = Math.max(
      0,
      subscription.expirationTime - Date.now() - PUSH_RENEWAL_WINDOW_MS
    );
    const timer = setTimeout(
      () => {
        runReconciliationInBackground(reconcile);
      },
      Math.min(delay, MAX_TIMER_MS)
    );
    return () => clearTimeout(timer);
  }, [reconcile, state, subscription]);

  async function subscribe() {
    if (state === "busy") {
      return;
    }
    setState("busy");
    setMessage(null);
    let access: NotificationPermission | "unsupported";
    try {
      access = await requestBrowserPermission();
    } catch {
      setMessage(
        "The browser could not open its notification permission prompt."
      );
      setState("ready");
      return;
    }
    setPermission(access);
    if (access !== "granted") {
      setMessage(permissionMessage(access));
      setState("ready");
      return;
    }
    const synchronized = await reconcile(true);
    if (!synchronized) {
      setState("ready");
    }
  }

  async function unsubscribe() {
    if (state === "busy" || !subscription) {
      return;
    }
    setState("busy");
    setMessage(null);
    let browserDisabled = false;
    try {
      await withSubscriptionLock(async () => {
        setPushOptIn(false);
        const registration = await navigator.serviceWorker.getRegistration("/");
        const current =
          (await registration?.pushManager.getSubscription()) ?? subscription;
        const endpoint = current.endpoint;
        if (!(await current.unsubscribe())) {
          throw new Error("The browser could not turn notifications off.");
        }
        browserDisabled = true;
        setSubscription(null);
        setState("ready");
        if (!(await removeServerSubscription(endpoint))) {
          setMessage(
            "Notifications are off in this browser. Server cleanup could not be confirmed."
          );
          return;
        }
        setMessage("Notifications are off for this browser.");
      });
    } catch (error) {
      if (!browserDisabled) {
        setPushOptIn(true);
      }
      setState(browserDisabled ? "ready" : "active");
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not disable notifications."
      );
    }
  }

  const active =
    subscription !== null && (state === "active" || state === "busy");
  const disabled = state === "busy" || state === "loading" || !supported;

  return (
    <section className="space-y-2.5 border-white/[0.06] border-b px-4 py-3">
      <div className="flex items-start gap-3">
        {active ? (
          <BellRingIcon className="mt-0.5 size-4 shrink-0 text-cyan-300" />
        ) : (
          <BellOffIcon className="mt-0.5 size-4 shrink-0 text-white/45" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[0.72rem] text-white/80">
            {active ? "Approval alerts are on" : "Approval alerts"}
          </p>
          <p className="mt-0.5 text-[0.65rem] text-white/42 leading-relaxed">
            Get a device notification when an agent needs permission or an
            answer.
          </p>
        </div>
        {active ? (
          <button
            className="rounded-xs border border-white/10 px-2 py-1 text-[0.62rem] text-white/65 hover:bg-white/8 disabled:opacity-50"
            disabled={disabled}
            onClick={unsubscribe}
            type="button"
          >
            {state === "busy" ? "Saving…" : "Turn off"}
          </button>
        ) : (
          <button
            className="rounded-xs border border-cyan-300/25 bg-cyan-300/10 px-2 py-1 text-[0.62rem] text-cyan-100 hover:bg-cyan-300/15 disabled:opacity-40"
            disabled={disabled || !enabledByServer || permission === "denied"}
            onClick={subscribe}
            type="button"
          >
            {state === "busy" ? "Saving…" : "Enable"}
          </button>
        )}
      </div>
      {needsHomeScreen ? (
        <p className="ml-7 text-[0.62rem] text-amber-200/70 leading-relaxed">
          On iPhone or iPad, add Chorus to your Home Screen and open it there
          before enabling alerts.
        </p>
      ) : null}
      {!(supported || needsHomeScreen) && state !== "loading" ? (
        <p className="ml-7 text-[0.62rem] text-white/45">
          Push needs a supported browser and a secure HTTPS connection.
        </p>
      ) : null}
      {!enabledByServer && state !== "loading" ? (
        <p className="ml-7 text-[0.62rem] text-white/35">
          Push is disabled by the server.
        </p>
      ) : null}
      {message ? (
        <p
          aria-live="polite"
          className="ml-7 text-[0.62rem] text-white/55"
          role="status"
        >
          {message}
        </p>
      ) : null}
    </section>
  );
}
