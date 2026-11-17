import { describe, expect, test } from "bun:test";
import { PROJECT_LIST_ERROR, requestRecentProjects } from "./projects-client";

describe("recent projects client", () => {
  test("loads a validated list without using a cached response", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const projects = await requestRecentProjects({
      fetcher: (input, init) => {
        requestUrl = input instanceof Request ? input.url : String(input);
        requestInit = init;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              projects: [
                {
                  directory: "/repo",
                  worktree: "/repo",
                  projectName: "Example",
                },
              ],
            }),
            { status: 200 }
          )
        );
      },
    });

    expect(requestUrl).toBe("/api/projects");
    expect(requestInit?.cache).toBe("no-store");
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(projects).toEqual([
      {
        directory: "/repo",
        worktree: "/repo",
        projectName: "Example",
        sandboxes: [],
      },
    ]);
  });

  test("preserves safe server errors and rejects invalid response bodies", async () => {
    await expect(
      requestRecentProjects({
        fetcher: async () =>
          new Response(
            JSON.stringify({
              code: "repository_registry_unavailable",
              message: "Repository access is temporarily unavailable.",
            }),
            { status: 503 }
          ),
      })
    ).rejects.toThrow("Repository access is temporarily unavailable.");

    await expect(
      requestRecentProjects({
        fetcher: () => Promise.resolve(new Response("not json")),
      })
    ).rejects.toThrow("invalid known-project list");

    await expect(
      requestRecentProjects({
        fetcher: () =>
          Promise.resolve(
            Response.json({ projects: [{ directory: "/repo" }] })
          ),
      })
    ).rejects.toThrow("invalid known-project list");

    await expect(
      requestRecentProjects({
        fetcher: () => Promise.resolve(new Response(null, { status: 503 })),
      })
    ).rejects.toThrow(PROJECT_LIST_ERROR);
  });

  test("normalizes timeouts and connection failures and lets auth expire globally", async () => {
    await expect(
      requestRecentProjects({
        fetcher: () =>
          Promise.reject(new DOMException("Timed out", "TimeoutError")),
      })
    ).rejects.toThrow("Loading known projects timed out");

    await expect(
      requestRecentProjects({
        fetcher: () => Promise.reject(new TypeError("Failed to fetch")),
      })
    ).rejects.toThrow("Could not reach Chorus");

    let unauthorizedResponse: Response | null = null;
    const projects = await requestRecentProjects({
      fetcher: () => Promise.resolve(new Response(null, { status: 401 })),
      onUnauthorized: (response) => {
        unauthorizedResponse = response;
        return true;
      },
    });

    expect(projects).toBeNull();
    expect(unauthorizedResponse).toBeInstanceOf(Response);
  });

  test("ignores a response after the request is canceled", async () => {
    const controller = new AbortController();
    let resolveResponse: ((response: Response) => void) | undefined;
    let unauthorizedCalled = false;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const request = requestRecentProjects({
      fetcher: () => responsePromise,
      onUnauthorized: () => {
        unauthorizedCalled = true;
        return true;
      },
      signal: controller.signal,
    });

    controller.abort();
    resolveResponse?.(new Response(null, { status: 401 }));

    await expect(request).resolves.toBeNull();
    expect(unauthorizedCalled).toBe(false);
  });
});
