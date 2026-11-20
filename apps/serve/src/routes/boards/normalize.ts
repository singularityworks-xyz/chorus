const LEADING_SLASHES = /^\/+/;
const LEADING_DOT_SEGMENTS = /^(\.\/)+/;
const PATH_SEPARATORS = /[\\/]/;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

export function normalizeAutocompletePath(path: string): string | null {
  const relative = path
    .replace(LEADING_SLASHES, "")
    .replace(LEADING_DOT_SEGMENTS, "");
  if (
    path.startsWith("\\") ||
    WINDOWS_DRIVE_PREFIX.test(relative) ||
    relative.includes("\0") ||
    relative.split(PATH_SEPARATORS).some((segment) => segment === "..")
  ) {
    return null;
  }
  return relative || ".";
}
