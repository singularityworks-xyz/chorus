import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { wsClientMessageSchema } from "./handler";

test("websocket message validation preserves client capabilities", async () => {
  const message = {
    capabilities: ["card.reordered"],
    since: 0,
    type: "hello",
  };
  const app = new Elysia().post("/message", ({ body }) => body, {
    body: wsClientMessageSchema,
  });

  const response = await app.handle(
    new Request("http://localhost/message", {
      body: JSON.stringify(message),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(message);
});
