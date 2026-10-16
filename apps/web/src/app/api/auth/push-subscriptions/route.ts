import { proxyChorusJson } from "@/lib/chorus-serve";

async function forward(request: Request, method: "DELETE" | "POST") {
  try {
    return await proxyChorusJson("/auth/push-subscriptions", {
      body: await request.text(),
      headers: { "content-type": "application/json" },
      method,
    });
  } catch {
    return Response.json(
      { code: "invalid_request", message: "could not read request body" },
      { status: 400 }
    );
  }
}

export function POST(request: Request) {
  return forward(request, "POST");
}

export function DELETE(request: Request) {
  return forward(request, "DELETE");
}
