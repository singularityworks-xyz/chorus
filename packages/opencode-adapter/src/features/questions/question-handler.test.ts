import { expect, test } from "bun:test";
import { createClient } from "../client/client";
import { QuestionHandler } from "./question-handler";

test("replies with selected option labels in question order", async () => {
  const originalFetch = globalThis.fetch;
  let replyBody: unknown;
  let replyPath: string | undefined;

  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString()
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "GET") {
        return Response.json([
          {
            id: "request-1",
            sessionID: "session-1",
            questions: [
              {
                custom: true,
                header: "First",
                multiple: true,
                options: [
                  { description: "", label: "Alpha" },
                  { description: "", label: "Beta" },
                ],
                question: "Choose the first answer",
              },
              {
                header: "Second",
                options: [
                  { description: "", label: "One" },
                  { description: "", label: "Two" },
                ],
                question: "Choose the second answer",
              },
            ],
          },
        ]);
      }

      replyPath = url.pathname;
      replyBody = await new Response(
        init?.body ?? (input instanceof Request ? input.body : null)
      ).json();
      return Response.json(true);
    },
    { preconnect: originalFetch.preconnect }
  );

  try {
    const { client } = createClient({ baseUrl: "http://127.0.0.1:4096" });
    const handler = new QuestionHandler(client);

    await handler.reply({
      answers: [
        {
          customAnswer: "  extra context  ",
          optionIndices: [1],
          questionIndex: 0,
        },
        { optionIndices: [0, 1], questionIndex: 1 },
      ],
      directory: "/repo",
      requestID: "request-1",
    });

    expect(replyPath).toBe("/question/request-1/reply");
    expect(replyBody).toEqual({
      answers: [
        ["Beta", "extra context"],
        ["One", "Two"],
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not hide an OpenCode question-list failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    () => Promise.resolve(new Response("missing", { status: 404 })),
    { preconnect: originalFetch.preconnect }
  );

  try {
    const { client } = createClient({ baseUrl: "http://127.0.0.1:4096" });
    const handler = new QuestionHandler(client);

    await expect(
      handler.reply({ answers: [], requestID: "request-1" })
    ).rejects.toThrow("OpenCode question.list failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfaces a rejected OpenCode reply without treating it as success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString()
      );
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "GET") {
        return Promise.resolve(
          Response.json([
            {
              id: "request-1",
              sessionID: "session-1",
              questions: [
                {
                  header: "Choice",
                  options: [{ description: "", label: "Alpha" }],
                  question: "Choose one",
                },
              ],
            },
          ])
        );
      }
      expect(url.pathname).toBe("/question/request-1/reply");
      return Promise.resolve(new Response("not pending", { status: 404 }));
    },
    { preconnect: originalFetch.preconnect }
  );

  try {
    const { client } = createClient({ baseUrl: "http://127.0.0.1:4096" });
    const handler = new QuestionHandler(client);

    await expect(
      handler.reply({
        answers: [{ optionIndices: [0], questionIndex: 0 }],
        requestID: "request-1",
      })
    ).rejects.toThrow("OpenCode question.reply failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfaces an OpenCode question-rejection failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    () => Promise.resolve(new Response("not pending", { status: 404 })),
    { preconnect: originalFetch.preconnect }
  );

  try {
    const { client } = createClient({ baseUrl: "http://127.0.0.1:4096" });
    const handler = new QuestionHandler(client);

    await expect(handler.reject("request-1")).rejects.toThrow(
      "OpenCode question.reject failed"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
