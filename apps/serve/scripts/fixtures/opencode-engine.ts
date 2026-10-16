import type { Event, Session } from "@chorus/oc-adapter";
import { z } from "zod";

interface FixtureSession {
  approved: boolean;
  busy: boolean;
  session: Session;
  text: string;
}

const SESSION_ROUTE = /^\/session\/([^/]+)(?:\/(.+))?$/;
const PERMISSION_ROUTE = /^\/permission\/permission-(session-\d+)\/reply$/;
const createSchema = z.object({ title: z.string().optional() });
const replySchema = z.object({ reply: z.enum(["once", "always", "reject"]) });

/** Scripted external engine: every event crosses the actual SDK HTTP/SSE path. */
export function startScriptedEngine() {
  const sessions = new Map<string, FixtureSession>();
  const streams = new Map<
    string,
    Set<ReadableStreamDefaultController<Uint8Array>>
  >();
  const encoder = new TextEncoder();
  let eventNumber = 0;

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
      id: `part-${entry.session.id}`,
      messageID: `message-${entry.session.id}`,
      sessionID: entry.session.id,
      type: "text" as const,
      text: entry.text,
    };
  }

  function begin(entry: FixtureSession) {
    const sessionID = entry.session.id;
    status(entry, true);
    emit(entry.session.directory, {
      id: eventId(),
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id: `message-${sessionID}`,
          sessionID,
          role: "assistant",
          time: { created: Date.now() },
          parentID: `user-${sessionID}`,
          modelID: "scripted",
          providerID: "fixture",
          mode: "build",
          agent: "build",
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
    if (!entry.approved) {
      status(entry, false);
    }
    return Response.json(true);
  }
  function sessionRequest(url: URL, directory: string) {
    const match = SESSION_ROUTE.exec(url.pathname);
    const entry = match?.[1] ? sessions.get(match[1]) : undefined;
    if (!entry || entry.session.directory !== directory) {
      return new Response(null, { status: 404 });
    }
    switch (match?.[2]) {
      case undefined:
        return Response.json(entry.session);
      case "prompt_async":
        begin(entry);
        return new Response(null, { status: 204 });
      case "abort":
        status(entry, false);
        return Response.json(true);
      case "message":
        return Response.json([]);
      case "diff":
        return Response.json([
          {
            file: "result.txt",
            status: "added",
            before: "",
            after: entry.text,
            additions: 1,
            deletions: 0,
            patch: `diff --git a/result.txt b/result.txt\nnew file mode 100644\n--- /dev/null\n+++ b/result.txt\n@@ -0,0 +1 @@\n+${entry.text.trimEnd()}\n`,
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
          if (path !== "result.txt" || !entry) {
            return new Response(null, { status: 404 });
          }
          return Response.json({ type: "text", content: entry.text });
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
          sessions.set(id, { session, text: "", busy: false, approved: false });
          return Response.json(session);
        }
        default:
          return url.pathname.startsWith("/permission/")
            ? permissionReply(request, url, directory)
            : sessionRequest(url, directory);
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
        messageID: `message-${sessionID}`,
        partID: `part-${sessionID}`,
        field: "text",
        delta,
      },
    });
  }
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    appendDelta,
    complete(sessionID: string) {
      const entry = sessions.get(sessionID);
      if (!entry?.approved) {
        throw new Error("scripted session needs approval");
      }
      entry.text = `${sessionID}\n`;
      status(entry, false);
    },
    async stop() {
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
