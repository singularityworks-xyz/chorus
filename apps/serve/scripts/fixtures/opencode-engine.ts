import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event, Session } from "@chorus/oc-adapter";
import { z } from "zod";

interface FixtureSession {
  approved: boolean;
  busy: boolean;
  canStreamReasoning: boolean;
  currentMessageId: string;
  currentReasoningPartId: string;
  currentTextPartId: string;
  prompted: boolean;
  reasoning: string;
  session: Session;
  text: string;
  turnNumber: number;
}

const SESSION_ROUTE = /^\/session\/([^/]+)(?:\/(.+))?$/;
const PERMISSION_ROUTE = /^\/permission\/permission-(session-\d+)\/reply$/;
const createSchema = z.object({ title: z.string().optional() });
const promptSchema = z.object({ agent: z.string().optional() });
const replySchema = z.object({ reply: z.enum(["once", "always", "reject"]) });
const revertSchema = z.object({
  messageID: z.string(),
  partID: z.string().optional(),
});
const FIXTURE_CHANGE_PATH = "result.txt";
const FIXTURE_CHANGE_CONTENT = "Scripted fixture change\n";

/** Scripted external engine: every event crosses the actual SDK HTTP/SSE path. */
export function startScriptedEngine() {
  const sessions = new Map<string, FixtureSession>();
  const streams = new Map<
    string,
    Set<ReadableStreamDefaultController<Uint8Array>>
  >();
  const encoder = new TextEncoder();
  let eventNumber = 0;
  let activeReasoningCursor = 0;
  const pendingPlanTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  function scopedSessions(directory: string) {
    return [...sessions.values()].filter(
      (entry) => entry.session.directory === directory
    );
  }
  function streamFor(directory: string) {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    return new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
        const listeners = streams.get(directory) ?? new Set();
        listeners.add(next);
        streams.set(directory, listeners);
        next.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
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
      case "message":
        return Response.json(
          entry.prompted
            ? [
                {
                  info: {
                    id: `user-${entry.session.id}`,
                    sessionID: entry.session.id,
                    role: "user",
                    time: { created: entry.session.time.created },
                    agent: "build",
                    model: { providerID: "fixture", modelID: "scripted" },
                  },
                  parts: [],
                },
              ]
            : []
        );
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
          return Response.json([]);
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
            currentReasoningPartId: `reasoning-${id}-0`,
            currentTextPartId: `part-${id}-0`,
            prompted: false,
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
    complete(sessionID: string) {
      const entry = sessions.get(sessionID);
      if (!entry?.approved) {
        throw new Error("scripted session needs approval");
      }
      entry.text = `${sessionID}\n`;
      status(entry, false);
    },
    async stop() {
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
