/** Whether a direct socket peer belongs to the IPv4 or IPv6 loopback range. */
const IPV4_MAPPED_PREFIX = /^::ffff:/;
const IPV4_OCTET_PATTERN = /^\d{1,3}$/;

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) {
    return false;
  }

  const normalized = address.toLowerCase().replace(IPV4_MAPPED_PREFIX, "");
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }

  const octets = normalized.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }

  return octets.every((octet) => {
    if (!IPV4_OCTET_PATTERN.test(octet)) {
      return false;
    }
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

export function canCreateLocalSession(input: {
  isProduction: boolean;
  localOrigins: readonly string[];
  origin: string | null;
  peerAddress: string | null | undefined;
  requestMarker: string | null;
}): boolean {
  return (
    !input.isProduction &&
    input.requestMarker === "1" &&
    isLoopbackAddress(input.peerAddress) &&
    input.origin !== null &&
    input.localOrigins.includes(input.origin)
  );
}
