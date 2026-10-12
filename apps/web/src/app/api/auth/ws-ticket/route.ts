import { proxyChorusJson } from "@/lib/chorus-serve";

export const dynamic = "force-dynamic";

export async function GET() {
  const upstream = await proxyChorusJson("/auth/ws-ticket", {
    method: "GET",
  });
  const headers = new Headers(upstream.headers);
  headers.set("cache-control", "no-store");

  return new Response(upstream.body, {
    headers,
    status: upstream.status,
  });
}
