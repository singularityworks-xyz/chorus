export const WS_CLOSE_ABNORMAL = 1006;

const IPV4_OCTET_PATTERN = /^\d{1,3}$/;

export function describeClose(
  closeEvent: { code: number; reason?: string },
  urlIsImplicit: boolean
): string {
  if (closeEvent.reason) {
    return closeEvent.reason;
  }
  if (urlIsImplicit && closeEvent.code === WS_CLOSE_ABNORMAL) {
    return "no /ws endpoint on this origin — set NEXT_PUBLIC_CHORUS_WS_URL to the Chorus serve address";
  }
  return `closed ${String(closeEvent.code)}`;
}

export function resolveSocketUrl(env: {
  allowLocalHostRebinding?: boolean;
  developmentServePort?: number;
  explicit?: string;
  isSecure: boolean;
  localServePort?: number;
  origin: string;
}): string {
  const explicit = env.explicit?.trim();
  const url = new URL(explicit || env.origin);

  if (!explicit && url.port === "3000") {
    const port =
      env.developmentServePort ??
      (isLoopbackHostname(url.hostname) ? env.localServePort : undefined);
    if (port) {
      url.port = String(port);
    }
  }

  if (
    explicit &&
    env.allowLocalHostRebinding &&
    isLoopbackHostname(url.hostname)
  ) {
    const page = new URL(env.origin);
    if (url.hostname !== page.hostname) {
      url.hostname = page.hostname;
    }
  }

  const secure = explicit
    ? url.protocol === "https:" || url.protocol === "wss:"
    : env.isSecure;

  url.protocol = secure ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) => IPV4_OCTET_PATTERN.test(octet) && Number(octet) <= 255
    )
  );
}
