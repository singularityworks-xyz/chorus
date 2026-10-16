import { proxyChorusJson } from "@/lib/chorus-serve";

export function GET() {
  return proxyChorusJson("/auth/devices");
}
