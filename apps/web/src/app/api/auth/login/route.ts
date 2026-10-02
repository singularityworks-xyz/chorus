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

  // No cookie is forwarded here: this call is what *creates* the session.
  const response = await postToServeUnauthenticated("/auth/login", body);

  if (isUnauthorized(response)) {
    // Deliberately indistinguishable from a wrong token on the client side.
    //
    // The upstream `Set-Cookie` still has to be forwarded. If serve ever issues
    // a cookie alongside a 401 -- to clear a stale one, say -- dropping it here
    // would leave the browser holding the dead cookie and failing again on the
    // next attempt for no visible reason.
    const rejected = Response.json(
      { code: "unauthorized", message: "invalid token" },
      { status: 401 }
    );
    for (const cookie of response.headers.getSetCookie()) {
      rejected.headers.append("set-cookie", cookie);
    }
    return rejected;
  }

  // The upstream `Set-Cookie` is preserved by the proxy, so the browser stores
  // the HttpOnly session exactly as serve issued it.
  return response;
}
