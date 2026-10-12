import { proxyChorusJson } from "@/lib/chorus-serve";

export function POST() {
  return proxyChorusJson("/auth/device", { method: "POST" });
}
