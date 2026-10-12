import { proxyChorusJson } from "@/lib/chorus-serve";

export function GET() {
  return proxyChorusJson("/auth/push-config", { method: "GET" });
}
