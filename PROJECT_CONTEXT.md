# Chorus project context

Chorus is a local-first workspace for coordinating OpenCode tasks across boards. People organize work into boards, watch agent sessions, and decide when work can run, needs review, or is complete.

## Main parts

| Area | Responsibility |
| --- | --- |
| `apps/web` | Workspace interface: boards, canvas, task cards, approvals, settings, and live updates. |
| `apps/serve` | Workspace service: task commands, durable workspace state, OpenCode connections, and remote-host features. |
| `apps/relay` | Remote connection service for reaching a Chorus workspace from another device. |
| `packages/contracts` | Shared schemas and types for workspace state, commands, and events. |
| `packages/opencode-adapter` | Boundary around OpenCode SDK calls and conversion of engine data into Chorus-owned types. |
| `packages/monaco`, `packages/voice` | Editor and voice features shared by the web app. |
| `packages/security`, `packages/logger` | Shared security and logging code. |

## Workspace workflow

The web app sends user commands to Serve. Serve validates and records workspace changes, then publishes updates through the shared workspace event stream. The web app applies those updates to its board and canvas views. OpenCode data passes through the adapter before it enters Chorus state.

The shared task states are `queue`, `in_progress`, `approve`, and `done`. Human decisions such as approval, rejection, abort, redirect, and dependency handling are part of the task workflow.

## Feature map

The web app groups user-facing behavior under `apps/web/src/features/`, including `canvas`, `kanban`, `composer`, `settings`, `workspace`, `sync`, `notifications`, `models`, and `auth`. Kanban subfeatures such as columns, questions, task cards, and task actions live in their own folders.

Serve groups backend behavior under `apps/serve/src/`, including `auth`, `bridge`, `hosting`, `opencode`, `projects`, `push`, `routes`, `tasks`, `workspace`, and `ws`. Larger areas have child folders for work such as task queues and review, OpenCode sessions, workspace persistence and projection, WebSocket delivery, and host transfers.

Relay groups remote access behavior under `apps/relay/src/`, including authentication, enrollment, rate limits, registry, tunnel, deployment, and its portal.

Shared packages hold workspace contracts and projectors, OpenCode translation, editor and voice features, and common security and logging code. The adapter is the boundary where OpenCode data becomes Chorus-owned state.

## Project boundaries

- Serve owns durable workspace state, commands, and event processing; the web app owns browser interaction and UI projection.
- Shared workspace payloads belong in `packages/contracts`.
- OpenCode protocol details stay at the adapter boundary before entering Chorus state.
- Human decisions remain explicit parts of task and workspace workflows.

This file gives project context and ownership. Use current source and tests for implementation details.
