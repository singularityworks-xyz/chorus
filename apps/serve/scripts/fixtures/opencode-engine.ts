import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingQuestion } from "@chorus/contracts";
import type {
  Event,
  Message,
  Part,
  Session,
  SessionMessageWithParts,
} from "@chorus/oc-adapter";
import { z } from "zod";

interface FixtureSession {
  approved: boolean;
  busy: boolean;
  canStreamReasoning: boolean;
  currentAgent: "build" | "plan";
  currentMessageId: string;
  currentReasoningPartId: string;
  currentTextPartId: string;
  pendingQuestions: Map<string, PendingQuestion>;
  prompted: boolean;
  questionNumber: number;
  reasoning: string;
  session: Session;
  text: string;
  turnNumber: number;
}

const SESSION_ROUTE = /^\/session\/([^/]+)(?:\/(.+))?$/;
const PERMISSION_ROUTE = /^\/permission\/permission-(session-\d+)\/reply$/;
const QUESTION_ROUTE = /^\/question\/([^/]+)\/(reply|reject)$/;
const createSchema = z.object({ title: z.string().optional() });
const promptSchema = z.object({ agent: z.string().optional() });
const replySchema = z.object({ reply: z.enum(["once", "always", "reject"]) });
const questionReplySchema = z.object({
  answers: z.array(
    z.object({
      customAnswer: z.string().optional(),
      optionIndices: z.array(z.number()).optional(),
    })
  ),
});
const revertSchema = z.object({
  messageID: z.string(),
  partID: z.string().optional(),
});
const FIXTURE_CHANGE_PATH = "result.txt";
const FIXTURE_CHANGE_CONTENT = "Scripted fixture change\n";

/** Scripted external engine: every event crosses the actual SDK HTTP/SSE path. */
export function startScriptedEngine({
  questionReplyDelayMs = 0,
}: {
  questionReplyDelayMs?: number;
} = {}) {
  const sessions = new Map<string, FixtureSession>();
  const streams = new Map<
    string,
    Set<ReadableStreamDefaultController<Uint8Array>>
  >();
  const encoder = new TextEncoder();
  let eventNumber = 0;
  let activeReasoningCursor = 0;
  const safeQuestionReplyDelayMs = Number.isFinite(questionReplyDelayMs)
    ? Math.min(10_000, Math.max(0, Math.floor(questionReplyDelayMs)))
    : 0;
  const pendingPlanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const keepAliveTimers = new Set<ReturnType<typeof setInterval>>();

  function emit(directory: string, event: Event) {
    const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const stream of streams.get(directory) ?? []) {
      stream.enqueue(frame);
    }
  }

  function eventId() {
    eventNumber += 1;
    return `fixture-event-${eventNumber}`;
  }
  function status(entry: FixtureSession, busy: boolean) {
    entry.busy = busy;
    emit(entry.session.directory, {
      id: eventId(),
      type: "session.status",
      properties: {
        sessionID: entry.session.id,
        status: { type: busy ? "busy" : "idle" },
      },
    });
  }

  function part(entry: FixtureSession) {
    return {
      id: entry.currentTextPartId,
      messageID: entry.currentMessageId,
      sessionID: entry.session.id,
      type: "text" as const,
      text: entry.text,
    };
  }

  function reasoningPart(entry: FixtureSession) {
    return {
      id: entry.currentReasoningPartId,
      messageID: entry.currentMessageId,
      sessionID: entry.session.id,
      type: "reasoning" as const,
      text: entry.reasoning,
      time: { start: Date.now() },
    };
  }

  function startTurn(entry: FixtureSession, agent: "build" | "plan") {
    const pendingPlanTimer = pendingPlanTimers.get(entry.session.id);
    if (pendingPlanTimer) {
      clearTimeout(pendingPlanTimer);
      pendingPlanTimers.delete(entry.session.id);
    }
    entry.turnNumber += 1;
    entry.currentMessageId = `message-${entry.session.id}-${entry.turnNumber}`;
    entry.currentReasoningPartId = `reasoning-${entry.session.id}-${entry.turnNumber}`;
    entry.currentTextPartId = `part-${entry.session.id}-${entry.turnNumber}`;
    entry.currentAgent = agent;
    entry.reasoning = "";
    entry.text = "";
    entry.approved = false;
    entry.canStreamReasoning = agent === "plan";
    entry.prompted = true;
    status(entry, true);
    emit(entry.session.directory, {
      id: eventId(),
      type: "message.updated",
      properties: {
        sessionID: entry.session.id,
        info: {
          id: entry.currentMessageId,
          sessionID: entry.session.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: `user-${entry.session.id}-${entry.turnNumber}`,
          modelID: "scripted",
          providerID: "fixture",
          mode: agent,
          agent,
          path: { cwd: entry.session.directory, root: entry.session.directory },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    });
  }

  function beginPlan(entry: FixtureSession) {
    startTurn(entry, "plan");
    entry.reasoning =
      "I’m checking the task scope and mapping a safe implementation sequence.";
    emit(entry.session.directory, {
      id: eventId(),
      type: "message.part.updated",
      properties: {
        sessionID: entry.session.id,
        part: reasoningPart(entry),
        time: Date.now(),
      },
    });
    entry.text = [
      "1. Inspect the affected board flow and its existing state transitions.",
      "2. Make the smallest focused change while preserving the shared provider selection.",
      "3. Verify the interaction and confirm failures remain visible and recoverable.",
    ].join("\n");
    emit(entry.session.directory, {
      id: eventId(),
      type: "message.part.updated",
      properties: {
        sessionID: entry.session.id,
        part: part(entry),
        time: Date.now(),
      },
    });

    const turnNumber = entry.turnNumber;
    const timer = setTimeout(() => {
      pendingPlanTimers.delete(entry.session.id);
      if (entry.turnNumber !== turnNumber) {
        return;
      }
      entry.canStreamReasoning = false;
      status(entry, false);
    }, 900);
    pendingPlanTimers.set(entry.session.id, timer);
  }

  function begin(entry: FixtureSession) {
    startTurn(entry, "build");
    const sessionID = entry.session.id;
    writeFileSync(
      join(entry.session.directory, FIXTURE_CHANGE_PATH),
      `${sessionID}\n`
    );
    entry.reasoning = "I’m mapping the request to the repository structure.";
    emit(entry.session.directory, {
      id: eventId(),
      type: "message.part.updated",
      properties: {
        sessionID,
        part: reasoningPart(entry),
        time: Date.now(),
      },
    });
    entry.text = "Working";
    emit(entry.session.directory, {
      id: eventId(),
      type: "message.part.updated",
      properties: { sessionID, part: part(entry), time: Date.now() },
    });
    emit(entry.session.directory, {
      id: eventId(),
      type: "permission.asked",
      properties: {
        id: `permission-${sessionID}`,
        sessionID,
        permission: "edit",
        patterns: ["result.txt"],
        always: [],
        metadata: {},
      },
    });
  }

  function askQuestion(sessionID: string): string {
    const entry = sessions.get(sessionID);
    if (!(entry?.busy && entry.approved)) {
      throw new Error("scripted session is not approved and running");
    }

    entry.questionNumber += 1;
    const questionNumber = entry.questionNumber;
    const requestID = `question-${sessionID}-${entry.turnNumber}-${questionNumber}`;
    const pendingQuestion: PendingQuestion = {
      id: requestID,
      sessionID,
      questions: [
        {
          custom: false,
          header:
            questionNumber === 1
              ? "Implementation choice"
              : `Implementation choice ${questionNumber}`,
          multiple: false,
          options: [
            {
              description: "Keep the behavior the task started with.",
              label: "Preserve current behavior",
            },
            {
              description: "Change the behavior based on the new request.",
              label: "Apply the requested change",
            },
          ],
          question:
            questionNumber === 1
              ? "Which behavior should the scripted task keep?"
              : `Which behavior should request ${questionNumber} keep?`,
        },
      ],
    };
    entry.pendingQuestions.set(requestID, pendingQuestion);
    emit(entry.session.directory, {
      id: eventId(),
      type: "question.asked",
      properties: {
        id: requestID,
        sessionID,
        questions: pendingQuestion.questions,
      },
    });
    return requestID;
  }

  function scopedSessions(directory: string) {
    return [...sessions.values()].filter(
      (entry) => entry.session.directory === directory
    );
  }
  function streamFor(directory: string) {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    return new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
        const listeners = streams.get(directory) ?? new Set();
        listeners.add(next);
        streams.set(directory, listeners);
        next.enqueue(encoder.encode(": connected\n\n"));
        // Bun closes otherwise-idle HTTP connections after its default idle
        // timeout. Match the OpenCode SSE heartbeat so long plan reviews do not
        // leave the fixture with a silently disconnected event stream.
        keepAlive = setInterval(() => {
          try {
            next.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            if (keepAlive) {
              clearInterval(keepAlive);
              keepAliveTimers.delete(keepAlive);
            }
          }
        }, 5000);
        keepAliveTimers.add(keepAlive);
      },
      cancel() {
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAliveTimers.delete(keepAlive);
        }
        streams.get(directory)?.delete(controller);
      },
    });
  }
  async function permissionReply(
    request: Request,
    url: URL,
    directory: string
  ) {
    const match = PERMISSION_ROUTE.exec(url.pathname);
    const entry = match?.[1] ? sessions.get(match[1]) : undefined;
    if (!entry || entry.session.directory !== directory) {
      return new Response(null, { status: 404 });
    }
    const body = replySchema.parse(await request.json());
    entry.approved = body.reply !== "reject";
    if (entry.approved) {
      entry.reasoning += " Permission restored and work resumed.";
      emit(directory, {
        id: eventId(),
        type: "message.part.updated",
        properties: {
          sessionID: entry.session.id,
          part: reasoningPart(entry),
          time: Date.now(),
        },
      });
    } else {
      status(entry, false);
    }
    return Response.json(true);
  }

  async function questionReply(request: Request, url: URL, directory: string) {
    const match = QUESTION_ROUTE.exec(url.pathname);
    const requestID = match?.[1];
    const entry = [...sessions.values()].find(
      (candidate) =>
        candidate.session.directory === directory &&
        requestID !== undefined &&
        candidate.pendingQuestions.has(requestID)
    );
    if (!(entry && requestID && match?.[2])) {
      return new Response(null, { status: 404 });
    }

    if (match[2] === "reply") {
      if (safeQuestionReplyDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, safeQuestionReplyDelayMs)
        );
      }
      const body = questionReplySchema.parse(await request.json());
      const firstAnswer = body.answers[0];
      const selectedOption = firstAnswer?.optionIndices?.[0];
      let answer = firstAnswer?.customAnswer;
      if (answer === undefined && selectedOption === 0) {
        answer = "Preserve current behavior";
      } else if (answer === undefined && selectedOption === 1) {
        answer = "Apply the requested change";
      }
      answer ??= "Answer recorded";
      entry.pendingQuestions.delete(requestID);
      const delta = ` The user chose: ${answer}.`;
      entry.text += delta;
      emit(directory, {
        id: eventId(),
        type: "message.part.delta",
        properties: {
          delta,
          field: "text",
          messageID: entry.currentMessageId,
          partID: entry.currentTextPartId,
          sessionID: entry.session.id,
        },
      });
      setTimeout(() => {
        if (entry.pendingQuestions.size === 0) {
          status(entry, false);
        }
      }, 100);
      return Response.json(true);
    }

    entry.pendingQuestions.delete(requestID);
    if (entry.pendingQuestions.size === 0) {
      status(entry, false);
    }
    return Response.json(true);
  }

  async function sessionRequest(request: Request, url: URL, directory: string) {
    const match = SESSION_ROUTE.exec(url.pathname);
    const entry = match?.[1] ? sessions.get(match[1]) : undefined;
    if (!entry || entry.session.directory !== directory) {
      return new Response(null, { status: 404 });
    }
    switch (match?.[2]) {
      case undefined:
        return Response.json(entry.session);
      case "prompt_async": {
        const body = promptSchema.parse(await request.json());
        if (body.agent === "plan") {
          beginPlan(entry);
        } else {
          begin(entry);
        }
        return new Response(null, { status: 204 });
      }
      case "abort":
        status(entry, false);
        return Response.json(true);
      case "message": {
        if (!entry.prompted) {
          return Response.json([] satisfies SessionMessageWithParts[]);
        }

        const userInfo = {
          id: `user-${entry.session.id}-${entry.turnNumber}`,
          sessionID: entry.session.id,
          role: "user",
          time: { created: entry.session.time.created },
          agent: entry.currentAgent,
          model: { providerID: "fixture", modelID: "scripted" },
        } satisfies Extract<Message, { role: "user" }>;
        const assistantInfo = {
          id: entry.currentMessageId,
          sessionID: entry.session.id,
          role: "assistant",
          time: { created: entry.session.time.created },
          parentID: userInfo.id,
          modelID: "scripted",
          providerID: "fixture",
          mode: entry.currentAgent,
          agent: entry.currentAgent,
          path: {
            cwd: entry.session.directory,
            root: entry.session.directory,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        } satisfies Extract<Message, { role: "assistant" }>;
        const parts = [reasoningPart(entry), part(entry)] satisfies Part[];
        const history = [
          { info: userInfo, parts: [] },
          { info: assistantInfo, parts },
        ] satisfies SessionMessageWithParts[];
        return Response.json(history);
      }
      case "revert": {
        const body = revertSchema.parse(await request.json());
        entry.session.revert = { messageID: body.messageID };
        rmSync(join(entry.session.directory, FIXTURE_CHANGE_PATH), {
          force: true,
        });
        return Response.json(entry.session);
      }
      case "unrevert":
        entry.session.revert = undefined;
        writeFileSync(
          join(entry.session.directory, FIXTURE_CHANGE_PATH),
          FIXTURE_CHANGE_CONTENT
        );
        return Response.json(entry.session);
      case "diff":
        return Response.json([
          {
            file: "result.txt",
            status: "added",
            before: "",
            after: entry.text || FIXTURE_CHANGE_CONTENT,
            additions: 1,
            deletions: 0,
            patch: `diff --git a/result.txt b/result.txt\nnew file mode 100644\n--- /dev/null\n+++ b/result.txt\n@@ -0,0 +1 @@\n+${(entry.text || FIXTURE_CHANGE_CONTENT).trimEnd()}\n`,
          },
        ]);
      default:
        return new Response(null, { status: 404 });
    }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const directory = url.searchParams.get("directory") ?? "";
      if (QUESTION_ROUTE.test(url.pathname)) {
        return questionReply(request, url, directory);
      }
      switch (url.pathname) {
        case "/global/health":
          return Response.json({ healthy: true, version: "1.19.0" });
        case "/global/config":
        case "/config":
          return Response.json({ provider: { fixture: {} } });
        case "/provider":
          return Response.json({
            all: [
              {
                id: "fixture",
                name: "Fixture Provider",
                source: "custom",
                env: [],
                options: {},
                models: {
                  scripted: {
                    id: "scripted",
                    providerID: "fixture",
                    api: {
                      id: "fixture",
                      url: "http://127.0.0.1",
                      npm: "@ai-sdk/openai-compatible",
                    },
                    name: "Scripted Model",
                    capabilities: {
                      temperature: true,
                      reasoning: true,
                      attachment: false,
                      toolcall: true,
                      input: {
                        text: true,
                        audio: false,
                        image: false,
                        video: false,
                        pdf: false,
                      },
                      output: {
                        text: true,
                        audio: false,
                        image: false,
                        video: false,
                        pdf: false,
                      },
                      interleaved: false,
                    },
                    cost: {
                      input: 0,
                      output: 0,
                      cache: { read: 0, write: 0 },
                    },
                    limit: { context: 32_000, output: 4096 },
                    status: "active",
                    options: {},
                    headers: {},
                    release_date: "2026-01-01",
                  },
                },
              },
            ],
            default: { fixture: "scripted" },
            connected: ["fixture"],
          });
        case "/provider/auth":
          return Response.json({
            fixture: [{ type: "api", label: "Fixture API key" }],
          });
        case "/event":
          return new Response(streamFor(directory), {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
            },
          });
        case "/session/status":
          return Response.json(
            Object.fromEntries(
              scopedSessions(directory).map((entry) => [
                entry.session.id,
                { type: entry.busy ? "busy" : "idle" },
              ])
            )
          );
        case "/permission":
          return Response.json(
            scopedSessions(directory)
              .filter((entry) => entry.busy && !entry.approved)
              .map((entry) => ({
                id: `permission-${entry.session.id}`,
                sessionID: entry.session.id,
                permission: "edit",
                patterns: ["result.txt"],
                always: [],
                metadata: {},
              }))
          );
        case "/question":
          return Response.json(
            scopedSessions(directory).flatMap((entry) => [
              ...entry.pendingQuestions.values(),
            ])
          );
        case "/file/content": {
          const entry = scopedSessions(directory)[0];
          const path = url.searchParams.get("path");
          if (path !== FIXTURE_CHANGE_PATH || !entry) {
            return new Response(null, { status: 404 });
          }
          return Response.json({
            type: "text",
            content: entry.text || FIXTURE_CHANGE_CONTENT,
          });
        }
        case "/session": {
          if (request.method !== "POST") {
            return new Response(null, { status: 405 });
          }
          const body = createSchema.parse(await request.json());
          const id = `session-${sessions.size + 1}`;
          const session: Session = {
            id,
            slug: id,
            projectID: "fixture",
            directory,
            title: body.title ?? id,
            version: "1.19.0",
            time: { created: Date.now(), updated: Date.now() },
          };
          sessions.set(id, {
            session,
            text: "",
            reasoning: "",
            busy: false,
            approved: false,
            canStreamReasoning: false,
            currentMessageId: `message-${id}-0`,
            currentAgent: "build",
            currentReasoningPartId: `reasoning-${id}-0`,
            currentTextPartId: `part-${id}-0`,
            pendingQuestions: new Map(),
            prompted: false,
            questionNumber: 0,
            turnNumber: 0,
          });
          return Response.json(session);
        }
        default:
          return url.pathname.startsWith("/permission/")
            ? permissionReply(request, url, directory)
            : sessionRequest(request, url, directory);
      }
    },
  });
  function appendDelta(sessionID: string, delta: string) {
    const entry = sessions.get(sessionID);
    if (!(entry?.busy && entry.approved)) {
      throw new Error("scripted session is not approved and running");
    }
    entry.text += delta;
    emit(entry.session.directory, {
      id: eventId(),
      type: "message.part.delta",
      properties: {
        sessionID,
        messageID: entry.currentMessageId,
        partID: entry.currentTextPartId,
        field: "text",
        delta,
      },
    });
  }
  function appendReasoningDelta(sessionID: string, delta: string) {
    const entry = sessions.get(sessionID);
    if (!(entry?.busy && (entry.approved || entry.canStreamReasoning))) {
      throw new Error("scripted session is not approved and running");
    }
    entry.reasoning += delta;
    emit(entry.session.directory, {
      id: eventId(),
      type: "message.part.delta",
      properties: {
        sessionID,
        messageID: entry.currentMessageId,
        partID: entry.currentReasoningPartId,
        field: "text",
        delta,
      },
    });
  }
  function appendActiveReasoningDelta(delta: string): boolean {
    const activeSessions = [...sessions.values()].filter(
      (candidate) =>
        candidate.busy && (candidate.approved || candidate.canStreamReasoning)
    );
    if (activeSessions.length === 0) {
      return false;
    }
    const entry = activeSessions[activeReasoningCursor % activeSessions.length];
    if (!entry) {
      return false;
    }
    activeReasoningCursor = (activeReasoningCursor + 1) % activeSessions.length;
    appendReasoningDelta(entry.session.id, delta);
    return true;
  }
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    appendDelta,
    appendReasoningDelta,
    appendActiveReasoningDelta,
    askQuestion,
    complete(sessionID: string) {
      const entry = sessions.get(sessionID);
      if (!entry?.approved) {
        throw new Error("scripted session needs approval");
      }
      entry.text = `${sessionID}\n`;
      status(entry, false);
    },
    async stop() {
      for (const timer of keepAliveTimers) {
        clearInterval(timer);
      }
      keepAliveTimers.clear();
      for (const timer of pendingPlanTimers.values()) {
        clearTimeout(timer);
      }
      pendingPlanTimers.clear();
      for (const listeners of streams.values()) {
        for (const controller of listeners) {
          controller.close();
        }
      }
      streams.clear();
      await server.stop(true);
    },
  };
}
