import { proxyChorusJson } from "@/lib/chorus-serve";

// biome-ignore lint/suspicious/useAwait: returns the proxied response
export async function POST() {
  return proxyChorusJson("/auth/logout", { method: "POST" });
}
