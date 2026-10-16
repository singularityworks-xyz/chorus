import { loadRelayConfig } from "../config";

export const testEnvironment = {
  RELAY_ACCOUNT_ORIGIN: "https://accounts.example.com",
  RELAY_TUNNEL_ORIGIN: "https://connect.example.com",
  RELAY_HOSTS_DOMAIN: "hosts.example.net",
  RELAY_AUTH_SECRET: "test-only-auth-secret-at-least-thirty-two-characters",
  RELAY_DATABASE_URL: "postgres://relay:test@127.0.0.1/relay",
  RELAY_GITHUB_CLIENT_ID: "test-github",
  RELAY_GITHUB_CLIENT_SECRET: "test-github-private",
  RELAY_GOOGLE_CLIENT_ID: "test-google",
  RELAY_GOOGLE_CLIENT_SECRET: "test-google-private",
  RELAY_TURNSTILE_SECRET: "test-turnstile-private",
  RELAY_TURNSTILE_SITE_KEY: "test-turnstile-public",
};

export function testConfig() {
  return loadRelayConfig(testEnvironment);
}
