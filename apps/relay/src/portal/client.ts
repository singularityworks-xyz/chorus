import {
  relayEnrollmentDescriptionSchema,
  relayHostListSchema,
  serializeHostPublicKey,
} from "@chorus/contracts";
import { z } from "zod";

declare global {
  interface Window {
    captchaReady: (token: string) => void;
  }
}

function element(id: string): HTMLElement {
  const result = document.getElementById(id);
  if (!result) {
    throw new Error("Connection page is incomplete. Refresh to try again.");
  }
  return result;
}

function button(id: string): HTMLButtonElement {
  const result = element(id);
  if (!(result instanceof HTMLButtonElement)) {
    throw new Error("Connection control is unavailable.");
  }
  return result;
}

function message(error: unknown): void {
  element("status").textContent =
    error instanceof Error
      ? error.message
      : "Could not complete this request. Try again.";
}

async function json<S extends z.ZodType>(
  url: string,
  schema: S,
  options: RequestInit = {}
): Promise<z.infer<S>> {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Sign in again to continue.");
    }
    if (response.status === 403) {
      throw new Error("Sign out and sign in again before approving this host.");
    }
    throw new Error("Could not complete this request. Try again.");
  }
  return schema.parse(await response.json());
}

let captchaToken = "";
window.captchaReady = (token) => {
  captchaToken = token;
  button("github").disabled = false;
  button("google").disabled = false;
};

for (const provider of ["github", "google"]) {
  button(provider).onclick = async () => {
    button(provider).disabled = true;
    try {
      element("status").textContent = "Opening sign-in…";
      const result = await json(
        "/api/auth/sign-in/social",
        z.object({ url: z.url() }),
        {
          method: "POST",
          headers: { "x-captcha-response": captchaToken },
          body: JSON.stringify({
            provider,
            callbackURL: location.origin + location.pathname,
          }),
        }
      );
      const target = new URL(result.url);
      if (target.protocol !== "https:") {
        throw new Error("Invalid sign-in destination.");
      }
      location.assign(target.href);
    } catch (error) {
      message(error);
      button(provider).disabled = false;
    }
  };
}

button("logout").onclick = async () => {
  try {
    await json("/api/auth/sign-out", z.object({ success: z.literal(true) }), {
      method: "POST",
      body: "{}",
    });
    location.assign("/");
  } catch (error) {
    message(error);
  }
};

async function showEnrollment(): Promise<void> {
  const id = z.uuid().parse(location.pathname.split("/")[2]);
  const endpoint = `/v1/enrollments/${encodeURIComponent(id)}`;
  const info = await json(endpoint, relayEnrollmentDescriptionSchema);
  element("host-name").textContent = info.label;
  element("host-id").textContent = info.hostId;
  const keyBytes = new TextEncoder().encode(
    serializeHostPublicKey(info.publicKey)
  );
  const fingerprint = new Uint8Array(
    await crypto.subtle.digest("SHA-256", keyBytes)
  );
  element("host-key").textContent = [...fingerprint]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  element("enrollment").hidden = false;
  button("approve").disabled =
    info.status !== "pending" || info.expiresAt <= Date.now();
  button("approve").onclick = async () => {
    button("approve").disabled = true;
    try {
      await json(
        `${endpoint}/approve`,
        z.object({ approved: z.literal(true) }),
        { method: "POST", body: "{}" }
      );
      element("status").textContent =
        "Connection approved. Return to Chorus on that machine to finish.";
      element("enrollment").hidden = true;
    } catch (error) {
      message(error);
      button("approve").disabled = false;
    }
  };
}

async function showHosts(): Promise<void> {
  const result = await json("/v1/hosts", relayHostListSchema);
  element("hosts").hidden = false;
  for (const host of result.hosts) {
    const row = document.createElement("div");
    row.className = "host";
    const title = document.createElement("strong");
    title.textContent = host.label;
    row.append(title);
    const detail = document.createElement("p");
    detail.textContent = host.online
      ? "Connected"
      : "Offline — keep this host on to connect";
    row.append(detail);
    if (host.online) {
      const link = document.createElement("a");
      link.href = `https://${host.hostname}/`;
      link.className = "action";
      link.textContent = "Open Chorus";
      row.append(link);
    }
    const revoke = document.createElement("button");
    revoke.className = "secondary";
    revoke.textContent = "Disconnect host";
    revoke.onclick = async () => {
      if (!(await confirmDisconnect())) {
        return;
      }
      revoke.disabled = true;
      try {
        await json(
          `/v1/hosts/${encodeURIComponent(host.hostId)}`,
          z.object({ revoked: z.literal(true) }),
          { method: "DELETE" }
        );
        row.remove();
        element("status").textContent = "Host disconnected.";
      } catch (error) {
        message(error);
        revoke.disabled = false;
      }
    };
    row.append(revoke);
    element("host-list").append(row);
  }
}

function confirmDisconnect(): Promise<boolean> {
  const dialog = element("disconnect-dialog");
  if (!(dialog instanceof HTMLDialogElement) || dialog.open) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    dialog.returnValue = "";
    dialog.onclose = () => resolve(dialog.returnValue === "disconnect");
    button("disconnect-cancel").onclick = () => dialog.close("cancel");
    button("disconnect-confirm").onclick = () => dialog.close("disconnect");
    dialog.showModal();
  });
}

async function load(): Promise<void> {
  try {
    const session = await json(
      "/api/auth/get-session",
      z.object({ user: z.object({ emailVerified: z.boolean() }) }).nullable()
    );
    if (!session?.user.emailVerified) {
      element("sign-in").hidden = false;
      element("status").textContent = "Sign in to continue.";
      return;
    }
    element("status").textContent =
      "Signed in. Workspace access still requires approval from its host.";
    if (location.pathname.startsWith("/enroll/")) {
      await showEnrollment();
    }
    await showHosts();
  } catch (error) {
    message(error);
  }
}

load().catch(message);
