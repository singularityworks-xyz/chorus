import { isUnauthorized, postToServeUnauthenticated } from "@/lib/chorus-serve";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { code: "invalid_request", message: "expected a JSON body" },
      { status: 400 }
    );
  }

  const response = await postToServeUnauthenticated("/auth/login", body);

  if (isUnauthorized(response)) {
    const rejected = Response.json(
      { code: "unauthorized", message: "invalid token" },
      { status: 401 }
    );
    for (const cookie of response.headers.getSetCookie()) {
      rejected.headers.append("set-cookie", cookie);
    }
    return rejected;
  }

  return response;
}
