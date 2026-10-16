import { hostEnrollmentBeginSchema } from "@chorus/contracts";
import { proxyChorusJson } from "@/lib/chorus-serve";

export async function POST(request: Request) {
  const body = hostEnrollmentBeginSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!body.success) {
    return Response.json({ code: "invalid_request" }, { status: 422 });
  }
  return proxyChorusJson("/hosting/remote/enrollment", {
    method: "POST",
    body: JSON.stringify(body.data),
  });
}
