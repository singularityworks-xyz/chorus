/** Exact origins, including port and protocol; sibling hosts are not trusted. */
export function mutationOriginMatches(
  origin: string | null,
  host: string | null,
  protocol: string
): boolean {
  if (
    !(
      origin &&
      host &&
      URL.canParse(origin) &&
      ["http", "https"].includes(protocol)
    )
  ) {
    return false;
  }
  const url = new URL(origin);
  return (
    url.protocol === `${protocol}:` &&
    url.host === host.toLowerCase() &&
    url.origin === origin
  );
}
