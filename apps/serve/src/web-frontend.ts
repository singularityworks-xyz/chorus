import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  InvalidPathError,
  resolveInside,
  SandboxEscapeError,
} from "./paths/sandbox";
import { withSecurityHeaders } from "./security-headers";

/**
 * Web frontend serving for Chorus
 *
 * Proxies to Next.js dev server in development,
 * serves static files in production
 */

import { createLogger } from "@chorus/logger";

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "WEB"
);

// Web frontend configuration
const WEB_DEV_URL = "http://localhost:3000"; // Next.js dev server

/**
 * Root of the static export.
 *
 * Overridable so the traversal guard can be tested against a temp directory
 * instead of depending on a real `apps/web/dist` build being present.
 */
let webProdDir = path.join(process.cwd(), "../web/dist");

export function setStaticRoot(directory: string): void {
  webProdDir = directory;
}

/**
 * Canonicalises a request path inside the static root.
 *
 * `path.join(webProdDir, pathname)` on its own is a traversal hole: a request
 * for `/../../etc/passwd` joins straight out of the web root and the file is
 * read and returned. `resolveInside` rejects that, and the realpath comparison
 * also rejects a symlink planted inside `dist` that points elsewhere.
 */
const LEADING_SLASHES = /^\/+/;

/**
 * Backslash as a path separator.
 *
 * A literal backslash is a legal filename character on POSIX, so `..\..\x` is
 * not traversal there — but it *is* traversal on Windows, and a URL path never
 * legitimately contains one. Rejecting it removes the ambiguity for a few bytes
 * of check.
 */
const BACKSLASH = /\\/;

function resolveStaticPath(pathname: string): string {
  // `decodeURIComponent` throws on a malformed escape such as `%zz`. That is a
  // client error, not a server fault, so it is turned into a rejected path
  // rather than a 500.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new InvalidPathError(pathname);
  }

  if (BACKSLASH.test(decoded)) {
    throw new InvalidPathError(pathname);
  }

  const relative =
    decoded === "/" ? "index.html" : decoded.replace(LEADING_SLASHES, "");

  const candidate = resolveInside(webProdDir, relative);

  // Defence in depth: `resolveInside` is lexical, so confirm the resolved path
  // is still inside the root after symlinks are followed.
  try {
    const root = realpathSync(webProdDir);
    const resolved = realpathSync(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new SandboxEscapeError(root, decoded);
    }
  } catch (error) {
    if (error instanceof SandboxEscapeError) {
      throw error;
    }
    // A missing file throws ENOENT, which the caller turns into the SPA
    // fallback. That is not a security failure.
  }

  return candidate;
}

/**
 * Serve web frontend - proxies to Next.js dev server in development,
 * serves static files in production
 */
export async function serveWebFrontend(pathname: string): Promise<Response> {
  const isDev = process.env.NODE_ENV !== "production";

  if (isDev) {
    // Development: Proxy to Next.js dev server
    try {
      const targetUrl = `${WEB_DEV_URL}${pathname}`;
      const response = await fetch(targetUrl, {
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      return withSecurityHeaders(response);
    } catch (error) {
      console.error("Failed to proxy to Next.js dev server:", error);
      return withSecurityHeaders(
        new Response(
          `<html><body><h1>Next.js Dev Server Not Running</h1>
        <p>Please start the Next.js dev server with: <code>cd apps/web && bun run dev</code></p>
        <p>Or build the static export: <code>cd apps/web && bun run build</code></p></body></html>`,
          { headers: { "Content-Type": "text/html" }, status: 503 }
        )
      );
    }
  }

  // Production: Serve static files
  let filePath: string;
  try {
    filePath = resolveStaticPath(pathname);
  } catch (error) {
    // A traversal attempt is a 403, not a 404: it should be visible in logs as
    // an attack rather than blending into normal 404 noise.
    if (
      error instanceof SandboxEscapeError ||
      error instanceof InvalidPathError
    ) {
      // A traversal attempt is a 403, not a 404: it should be visible in logs as
      // an attack rather than blending into normal 404 noise.
      logger.warn("static-path-escape-rejected", { pathname });
      return withSecurityHeaders(
        new Response("forbidden", {
          headers: { "Content-Type": "text/plain" },
          status: 403,
        })
      );
    }
    return withSecurityHeaders(
      new Response("Web frontend not found. Please build the app.", {
        headers: { "Content-Type": "text/plain" },
        status: 404,
      })
    );
  }

  try {
    const content = await readFile(filePath);
    const contentType = getContentType(path.extname(filePath));
    return withSecurityHeaders(
      new Response(content, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": contentType,
        },
      })
    );
  } catch {
    // If file not found, try serving index.html (SPA fallback)
    try {
      const indexPath = resolveStaticPath("/");
      const content = await readFile(indexPath);
      return withSecurityHeaders(
        new Response(content, {
          headers: { "Content-Type": "text/html" },
        })
      );
    } catch {
      return withSecurityHeaders(
        new Response("Web frontend not found. Please build the app.", {
          headers: { "Content-Type": "text/plain" },
          status: 404,
        })
      );
    }
  }
}

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".map": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".webmanifest": "application/manifest+json",
    ".txt": "text/plain",
    ".wasm": "application/wasm",
  };
  return types[ext] || "application/octet-stream";
}

/**
 * Exposed for tests: the traversal decision is the security-relevant part, and
 * asserting it against a temp tree keeps the HTTP layer out of the picture.
 */
export { resolveStaticPath };
