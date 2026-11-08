import { describe, expect, test } from "bun:test";
import { requireAcceptedCommand } from "./command-client";

describe("accepted command responses", () => {
  test("accepts only a valid positive acknowledgment", async () => {
    await expect(
      requireAcceptedCommand(
        new Response(JSON.stringify({ accepted: true }), { status: 200 }),
        { fallback: "Command failed." }
      )
    ).resolves.toBeUndefined();
  });

  test("rejects negative and malformed success acknowledgments", async () => {
    await expect(
      requireAcceptedCommand(
        new Response(JSON.stringify({ accepted: false }), { status: 200 }),
        {
          fallback: "Command failed.",
          rejectedMessage: "The task is still running.",
        }
      )
    ).rejects.toThrow("The task is still running.");

    await expect(
      requireAcceptedCommand(
        new Response(JSON.stringify({}), { status: 200 }),
        { fallback: "Command failed." }
      )
    ).rejects.toThrow("invalid command acknowledgment");
  });

  test("preserves safe API errors and uses the fallback for malformed errors", async () => {
    await expect(
      requireAcceptedCommand(
        new Response(
          JSON.stringify({
            code: "stale_request",
            message: "This request expired.",
          }),
          { status: 409 }
        ),
        { fallback: "Command failed." }
      )
    ).rejects.toThrow("This request expired.");

    await expect(
      requireAcceptedCommand(new Response("not json", { status: 503 }), {
        fallback: "Command failed safely.",
      })
    ).rejects.toThrow("Command failed safely.");
  });
});
