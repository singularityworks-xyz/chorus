import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pushSubscriptionSchema } from "@chorus/contracts";

export const pushSubscriptionInputSchema = pushSubscriptionSchema.superRefine(
  (input, context) => {
    try {
      const endpoint = new URL(input.endpoint);
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.port
      ) {
        context.addIssue({
          code: "custom",
          message:
            "push endpoint must be an HTTPS URL without credentials or a fragment",
          path: ["endpoint"],
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "push endpoint must be an absolute HTTPS URL",
        path: ["endpoint"],
      });
    }
  }
);

export interface EndpointPolicy {
  allowedHosts?: string[];
  lookupHost?: (hostname: string) => Promise<Array<{ address: string }>>;
}

const DEFAULT_PROVIDER_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
];
const OPTIONAL_TRAILING_DOT = /\.$/;

function isAllowedHost(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase().replace(OPTIONAL_TRAILING_DOT, "");
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase().replace(OPTIONAL_TRAILING_DOT, "");
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    a >= 224
  );
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !isPrivateIpv4(address);
  }
  if (family !== 6) {
    return false;
  }

  const normalized = address.toLowerCase();
  // Web push providers are publicly routable. Restrict IPv6 to global unicast,
  // excluding special translation/documentation ranges and mapped IPv4.
  return (
    (normalized.startsWith("2") || normalized.startsWith("3")) &&
    !normalized.startsWith("2001:db8:") &&
    !normalized.startsWith("2002:") &&
    !normalized.startsWith("64:ff9b:")
  );
}

export async function assertSafePushEndpoint(
  endpoint: string,
  policy: EndpointPolicy = {}
): Promise<URL> {
  const parsed = new URL(endpoint);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.port
  ) {
    throw new Error("push endpoint is not an allowed HTTPS destination");
  }

  const allowedHosts = [
    ...DEFAULT_PROVIDER_HOSTS,
    ...(policy.allowedHosts ?? []),
  ];
  if (!isAllowedHost(parsed.hostname, allowedHosts)) {
    throw new Error("push provider host is not allowed");
  }

  const addresses = await (policy.lookupHost ?? defaultLookup)(parsed.hostname);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicAddress(address.address))
  ) {
    throw new Error("push provider resolved to a non-public address");
  }
  return parsed;
}

function defaultLookup(hostname: string): Promise<Array<{ address: string }>> {
  return lookup(hostname, { all: true, verbatim: true });
}

export type { PushSubscriptionInput } from "@chorus/contracts";
