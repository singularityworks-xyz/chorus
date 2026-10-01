<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project guidelines

- use `bun` for the package manager
- when installing packages, use `bun add` or `bun add -d` instead of manually editing dependency lists
- use `context7` to get the latest docs for any library, framework, or package you are using
- prefer official docs and primary sources when working with `next.js`, `react`, `react flow`, `elysia`, `spacetimedb`, `opencode`, `superplane`, `armoriq`, and `elevenlabs`

## TypeScript

- avoid `as any` at all costs
- prefer inferred types, schema-derived types, and function return types
- if a cast is necessary, keep it narrow and local
- use shared enums/unions for statuses and event types instead of loose strings
- validate cross-app payloads with schemas instead of trusting raw objects

## Repo structure

- keep shared code in `packages/*` instead of copying code between apps
- if code is used by both frontend and backend, move it to a shared package
- keep files small and focused
- avoid giant components, giant route files, and giant utility files
- split code by feature/domain, not by random helper dumping
- make changes in a way that lets multiple people work without constant merge conflicts

## Frontend

- use `tailwindcss` for styling whenever possible; only add custom css when needed
- keep `next.js` app router code server-first by default
- only use `"use client"` where interactivity actually requires it
- do not make whole pages/layouts client components if only a small part needs client-side behavior
- use `react flow` for canvas, graph, node, and edge interactions
- keep the core UI centered on cards, kanban lanes, canvas state, approvals, and task control
- make sure UI changes work on both desktop and mobile
- avoid generic chat-style UI patterns when building Chorus features

## Backend and realtime

- use `apps/serve` for bridge/server code when that app exists
- use `elysia` for http and websocket server code
- keep routes, websocket handlers, adapters, and event processing in separate files/modules
- treat the native `websocket` `/ws` event log as the single shared realtime state layer (commands over HTTP, state over WS)
- do not duplicate durable state logic in both websocket handlers and UI code
- normalize external events before using them in app state or UI

## Integrations

- wrap `opencode` access in a dedicated adapter instead of spreading raw sdk calls everywhere
- keep `superplane`, `armoriq`, and `elevenlabs` integrations isolated behind clear modules
- do not leak third-party payload shapes across the whole codebase
- convert external events into Chorus-owned types before storing or rendering them

## Quality

- run `bun run check` after making changes to catch linting and formatting issues
- run `bun run check-types` after making changes to catch type errors
- write tests for your code when the change introduces behavior worth protecting
- use the right test type for the change: unit, integration, and e2e when appropriate
- run the relevant tests after making changes

## Git commits

- git commit subjects must use this format only: `<type>[<AREA>]: <summary>`
- valid examples: `feat[COLLAB]: add dependency-aware task wiring` and `chore[TEST]: tighten pre-push type checks`
- use lowercase commit types like `feat`, `fix`, `chore`, `refactor`, `docs`, or `test`
- use uppercase area tags inside brackets like `COLLAB`, `TEST`, `WEB`, `SERVE`, `CANVAS`, `AGENTS`, or another short project-relevant area
- after the subject line, include a commit body
- the commit body must contain at least one clear paragraph describing what changed, where it changed, and any important behavior or migration detail
- do not use one-line commits without a body
- keep the subject concise and put the implementation detail in the body paragraph
- **merge pull requests normally (`gh pr merge --merge`), never with `--squash` or `--rebase`** — each phase must stay individually revertable on `main`, so the commit history is part of the deliverable
- wait for CI to reach a clean state before merging; do not merge while checks are pending or failing

## Chorus-specific rules

- keep task state explicit: `queue`, `in_progress`, `approve`, `done`, or other shared typed statuses
- approvals, aborts, redirects, dependencies, and model races should be treated as first-class features, not hacks
- keep the human control layer clear in the UI
- keep realtime state and command handling predictable and easy to trace
