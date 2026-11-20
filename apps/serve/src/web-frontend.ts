import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@chorus/logger";
import {
  InvalidPathError,
  resolveInside,
  SandboxEscapeError,
} from "./paths/sandbox";
import { withSecurityHeaders } from "./security-headers";

const logger = createLogger(
  { env: process.env.NODE_ENV === "production" ? "production" : "development" },
  "WEB"
);

const WEB_DEV_URL = "http://localhost:3000";

let webProdDir = path.join(process.cwd(), "../web/dist");

export function setStaticRoot(directory: string): void {
  webProdDir = directory;
}

const LEADING_SLASHES = /^\/+/;

const BACKSLASH = /\\/;

function resolveStaticPath(pathname: string): string {
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

export async function serveWebFrontend(pathname: string): Promise<Response> {
  const isDev = process.env.NODE_ENV !== "production";

  if (isDev) {
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

  let filePath: string;
  try {
    filePath = resolveStaticPath(pathname);
  } catch (error) {
    // A traversal attempt is a 403, not a 404: it should be visible in logs as

    if (
      error instanceof SandboxEscapeError ||
      error instanceof InvalidPathError
    ) {
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
    const serviceWorkerHeaders =
      pathname === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {};
    return withSecurityHeaders(
      new Response(content, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": contentType,
          ...serviceWorkerHeaders,
        },
      })
    );
  } catch {
    if (pathname === "/sw.js") {
      return withSecurityHeaders(
        new Response("service worker not found", {
          headers: { "Content-Type": "text/plain" },
          status: 404,
        })
      );
    }

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

export { resolveStaticPath };
