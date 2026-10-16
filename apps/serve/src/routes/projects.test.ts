import { describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { createProjectRoutes } from "./projects";

function makeProjectService() {
  return {
    configureProvider: mock(async () => true),
    listConfiguredProviders: mock(async () => ({
      providerIDs: ["openrouter"],
    })),
    listCredentials: mock(async () => ({
      credentials: [
        {
          id: "openrouter",
          type: "api",
        },
      ],
    })),
    listProvidersForDirectory: mock(async () => ({
      providers: [
        {
          connected: true,
          id: "anthropic",
          modelCount: 1,
          name: "Anthropic",
          supportsApi: true,
          supportsOauth: false,
        },
      ],
    })),
    listProviders: mock(async () => ({
      providers: [
        {
          connected: true,
          id: "anthropic",
          modelCount: 1,
          name: "Anthropic",
          supportsApi: true,
          supportsOauth: false,
        },
      ],
    })),
    listModelsForDirectory: mock(async () => ({
      defaultModel: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
      },
      models: [
        {
          attachment: true,
          connected: true,
          modelID: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          providerID: "anthropic",
          providerName: "Anthropic",
          reasoning: true,
          releaseDate: "2025-01-01",
          temperature: true,
          toolCall: true,
        },
      ],
    })),
    listModels: mock(async () => ({
      defaultModel: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
      },
      models: [
        {
          attachment: true,
          connected: true,
          modelID: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          providerID: "anthropic",
          providerName: "Anthropic",
          reasoning: true,
          releaseDate: "2025-01-01",
          temperature: true,
          toolCall: true,
        },
      ],
    })),
    listProjects: mock(async () => ({
      projects: [
        {
          directory: "/tmp/repo",
          worktree: "/tmp/repo",
          projectId: "proj-1",
          projectName: "repo",
          sandboxes: [],
        },
      ],
    })),
    launchAuthLogin: mock(async () => true),
    openModels: mock(async () => true),
    openFolder: mock(async () => ({
      title: "repo",
      repo: {
        directory: "/tmp/repo",
        worktree: "/tmp/repo",
        projectId: "proj-1",
        projectName: "repo",
        branch: "main",
        sandboxes: [],
      },
    })),
    runConnect: mock(async () => true),
  };
}

describe("project routes", () => {
  test("lists provider status", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(
      new Request("http://localhost/providers")
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      providers: [
        {
          connected: true,
          id: "anthropic",
          modelCount: 1,
          name: "Anthropic",
          supportsApi: true,
          supportsOauth: false,
        },
      ],
    });
  });

  test("lists stored auth credentials", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(
      new Request("http://localhost/opencode/auth-credentials")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credentials: [
        {
          id: "openrouter",
          type: "api",
        },
      ],
    });
  });

  test("lists provider status for a specific directory", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(
      new Request("http://localhost/providers?directory=/tmp/repo")
    );

    expect(response.status).toBe(200);
    expect(projectService.listProvidersForDirectory).toHaveBeenCalledWith(
      "/tmp/repo"
    );
  });

  test("lists available models", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(new Request("http://localhost/models"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      defaultModel: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
      },
      models: [
        {
          attachment: true,
          connected: true,
          modelID: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          providerID: "anthropic",
          providerName: "Anthropic",
          reasoning: true,
          releaseDate: "2025-01-01",
          temperature: true,
          toolCall: true,
        },
      ],
    });
  });

  test("lists available models for a specific directory", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(
      new Request("http://localhost/models?directory=/tmp/repo")
    );

    expect(response.status).toBe(200);
    expect(projectService.listModelsForDirectory).toHaveBeenCalledWith(
      "/tmp/repo"
    );
  });

  test("lists known projects", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(new Request("http://localhost/projects"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projects: [
        {
          directory: "/tmp/repo",
          worktree: "/tmp/repo",
          projectId: "proj-1",
          projectName: "repo",
          sandboxes: [],
        },
      ],
    });
  });

  test("opens a folder and returns a board seed", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(
      new Request("http://localhost/projects/open-folder", {
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      title: "repo",
      repo: {
        directory: "/tmp/repo",
        worktree: "/tmp/repo",
        projectId: "proj-1",
        projectName: "repo",
        branch: "main",
        sandboxes: [],
      },
    });
  });

  test("disables the host folder picker in production", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(
      createProjectRoutes(projectService as never, true)
    );

    const response = await app.handle(
      new Request("http://localhost/projects/open-folder", { method: "POST" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "host_folder_picker_disabled",
      message:
        "Configure CHORUS_REPOSITORY_ROOTS to add repositories on this server",
    });
    expect(projectService.openFolder).not.toHaveBeenCalled();
  });

  test("opens the OpenCode model dialog", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(
      new Request("http://localhost/opencode/models", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          directory: "/tmp/repo",
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      opened: true,
    });
    expect(projectService.openModels).toHaveBeenCalledWith("/tmp/repo");
  });

  test("runs the OpenCode connect flow", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(
      new Request("http://localhost/opencode/connect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          directory: "/tmp/repo",
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      opened: true,
    });
    expect(projectService.runConnect).toHaveBeenCalledWith("/tmp/repo");
  });

  test("configures a provider for chorus", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(
      new Request("http://localhost/opencode/configure-provider", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          directory: "/tmp/repo",
          providerID: "openrouter",
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      configured: true,
      providerIDs: ["openrouter"],
    });
    expect(projectService.configureProvider).toHaveBeenCalledWith({
      directory: "/tmp/repo",
      providerID: "openrouter",
    });
  });

  test("launches auth login in a terminal", async () => {
    const projectService = makeProjectService();
    const app = new Elysia().use(createProjectRoutes(projectService as never));

    const response = await app.handle(
      new Request("http://localhost/opencode/auth-login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          directory: "/tmp/repo",
        }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      launched: true,
    });
    expect(projectService.launchAuthLogin).toHaveBeenCalledWith("/tmp/repo");
  });
});
