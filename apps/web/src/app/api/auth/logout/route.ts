import { proxyChorusJson } from "@/lib/chorus-serve";

// biome-ignore lint/suspicious/useAwait: returns the proxied response
export async function POST() {
  // Serve clears the cookie and the proxy forwards the `Set-Cookie` that does it.
  return proxyChorusJson("/auth/logout", { method: "POST" });
}
