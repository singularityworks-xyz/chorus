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

## How workspace changes move

The web app sends user commands to Serve. Serve validates and records workspace changes, then publishes updates through the shared workspace event stream. The web app applies those updates to its board and canvas views. OpenCode data passes through the adapter before it enters Chorus state.

The shared task states are `queue`, `in_progress`, `approve`, and `done`. Human decisions such as approval, rejection, abort, redirect, and dependency handling are part of the task workflow.

## Feature map

The web app groups user-facing behavior under `apps/web/src/features/`, including `canvas`, `kanban`, `composer`, `settings`, `workspace`, `sync`, `notifications`, `models`, and `auth`. Kanban subfeatures such as columns, questions, task cards, and task actions live in their own folders.

Serve groups backend behavior under `apps/serve/src/`, including `auth`, `bridge`, `hosting`, `opencode`, `projects`, `push`, `routes`, `tasks`, `workspace`, and `ws`. The workspace store composes persistence, projections, commands, agent events, and pending approvals.

## Refactor guide

- Keep durable workspace state and event handling in Serve; keep UI projection and interaction state in the web app.
- Keep shared payloads in `packages/contracts` and third-party OpenCode shapes inside `packages/opencode-adapter`.
- Put each user or service feature in its domain folder, with subfeatures in child folders when they have their own behavior and tests.
- Preserve behavioral boundaries around persistence order, event sequencing, authentication, filesystem trust, and shutdown.

This file is a project map, not an API reference. Check current source and tests before relying on implementation details.
