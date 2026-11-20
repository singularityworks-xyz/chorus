import { describe, expect, test } from "bun:test";
import { makeApp } from "../test-support";

describe("GET /health", () => {
  test("returns ok status with timestamp", async () => {
    const { app } = makeApp();

    const res = await app.handle(new Request("http://localhost/health"));

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      timestamp: expect.any(Number),
    });
  });
});
describe("GET /bridge/status", () => {
  test("returns bridge status", async () => {
    const { app } = makeApp();

    const res = await app.handle(new Request("http://localhost/bridge/status"));

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      connected: true,
      opencodeUrl: "http://localhost:4096",
      activeSessions: 2,
      subscribedDirectories: ["/repo"],
      uptime: 1000,
    });
  });
});
