import { buildDeviceCookieHeader, issueDeviceCookie } from "./device";
import { buildSessionCookieHeader, type IssuedSession } from "./session";

/** A registered session and its signed device identity are issued together. */
export async function sessionHeaders(
  session: IssuedSession,
  token: string,
  secure: boolean
): Promise<string[]> {
  const headers = [
    buildSessionCookieHeader(session.cookie, session.expiresAt, secure),
  ];
  if (session.deviceId) {
    headers.push(
      buildDeviceCookieHeader(
        await issueDeviceCookie(token, session.deviceId),
        secure
      )
    );
  }
  return headers;
}
