import { hostRemoteEnabledSchema } from "@chorus/contracts";
import { proxyChorusJson } from "@/lib/chorus-serve";

export async function POST(request: Request) {
  const body = hostRemoteEnabledSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!body.success) {
    return Response.json({ code: "invalid_request" }, { status: 422 });
  }
  return proxyChorusJson("/hosting/remote/connection", {
    method: "POST",
    body: JSON.stringify(body.data),
  });
}
