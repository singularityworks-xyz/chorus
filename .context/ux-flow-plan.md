# Chorus UX flow improvement plan

Status: UX1 code is implemented; browser acceptance remains outstanding.
UX2–UX5 remain planned.
Created: 2026-10-14.
Sources: `specsheet.md`, `implementation-plan.md`, `agent-context.md`, and the
current Web and Serve implementation. This is a companion UX workstream; it
does not renumber or replace the existing engineering phases.

## 1. Goal and scope

Make the existing single-operator application understandable from first login
through repository selection, task execution, human decisions, and result review.
Keep the desktop canvas and responsive phone lanes as the core workspace.

Target journey:

```text
Start Chorus locally -> find access token -> sign in
  -> start first board -> select repository and ready model -> submit first task
  -> watch progress -> answer requests / review result -> continue on the board
```

Returning visitors resume their workspace or the board/card in a notification
link. Setup appears only when a required capability is missing.

VPS execution handoff, background project-file sync, cloud ownership transfer,
and continuation while the laptop is shut down are deferred. A later backend
design must define those capabilities before runtime-switch controls are added.
Existing VPS deployment work remains tracked in engineering Phase 8.

## 2. Access token: current behavior and onboarding gap

Token resolution happens in `apps/serve/src/auth/token.ts`, called at startup by
`apps/serve/src/index.ts`:

1. A nonempty `CHORUS_TOKEN` environment variable wins. Serve does not write that
   value into a token file.
2. In development, with no environment token, Serve reuses a nonempty
   `<DATA_DIR>/chorus.token` file.
3. Otherwise development generates 32 random bytes, encodes them as 64 hex
   characters, and saves the token to that file. Restarts reuse it.
4. Production requires `CHORUS_TOKEN`; missing configuration stops startup.

The actual bare-runtime default for `DATA_DIR` is `~/.chorus`, from
`apps/serve/src/config/index.ts`. On this Windows machine the default token file
is `C:\Users\amana\.chorus\chorus.token`; its existence was confirmed without
reading or displaying the credential. A `DATA_DIR` override changes the path.

The owner retrieves the generated token locally, enters it at `/login`, and
receives an HttpOnly session cookie. The instance has one operator across
devices; it has no account-registration or per-user token-generation flow.

Current gaps:

- `/login` asks for a token without explaining where the owner gets it.
- Startup reports the file path only when it generates a token, so later boots
  provide no credential-discovery guidance.
- `.env.example` presents `/data` as the default although bare Serve defaults
  to `~/.chorus`; its production settings need a clear distinction from local
  development instructions.
- A first unauthenticated workspace visit can show “Session expired.”

Keep token retrieval local. Public login/help screens can explain the default
location and configuration, but must never return or generate an instance token.
Do not place credentials in URLs, application logs, browser storage, or events.

## 3. Current UX findings

These findings describe the baseline before UX1. The UX1 implementation below
addresses token discovery, startup guidance, environment-example defaults, and
the first-visit sign-in/loading states.

- Desktop has no primary empty-workspace action; phone has guidance text without
  a creation action. The persistent composer requires a selected board.
- Repository selection is nested under File, Previous Working, and Known
  Projects. Those actions create boards, which their labels do not explain.
- Provider configuration is inside a small header dropdown; some actions launch
  host tools rather than explaining the setup in the browser.
- Global notifications cover permission/question requests, but final manual
  reviews also need discoverability.
- Approval actions use icons and tooltips. The current generic review handler
  sends a “Please proceed with implementing this plan” prompt, which is not an
  acceptance action for completed work.
- Several commands expose failure only in the console. Stop ignores unsuccessful
  HTTP responses, and approval handlers move cards locally before confirmation.
- Retry, Edit/Window menu items, and several advertised canvas shortcuts have
  incomplete actions. Connecting canvas nodes currently creates local visual
  edges without durable task-dependency behavior.
- Phone lanes place Queue and Running before the decisions that matter when away.

These findings come from source inspection. Live visual/browser acceptance is
still required during implementation.

## 4. Product decisions for this workstream

- Keep server statuses `queue`, `in_progress`, `approve`, and `done`; show user
  labels **Queue**, **Running**, **Needs you**, and **Done**.
- Keep the existing default review mode (`auto`). Explain it as “Complete tasks
  automatically” versus “Review completed work.” Permission and question
  requests always pause for a human response in either mode.
- Distinguish permission requests, questions, and completed-result review by
  their actual server state and typed payloads.
- A board represents one repository working copy and one session. The first
  board uses the primary checkout; additional boards for that repository use
  isolated worktrees. Display the checkout/branch before work starts.
- Preserve the current busy-board restriction: explain that the current task
  must finish or stop before another task starts. Do not imply a new scheduler.
- One compact header exposes **New board**, **Needs you**, and **Settings**.
  Desktop retains the canvas, a board switcher, and task details; phone uses
  decisions and stacked lanes.
- Keep the existing Tailwind/component foundation, React Flow, and Monaco.
  No design-system replacement is needed.

## 5. Ordered implementation phases

### UX1 — Access and first-visit states

Changes:

- Route an unauthenticated first visit into an understandable sign-in flow.
  Use neutral sign-in wording for any rejected session: Serve intentionally
  collapses missing, expired, and invalid credentials into the same 401, so the
  browser cannot safely claim that a session expired.
- Preserve safe board/card return destinations and the existing 401 retry stop.
- Add “Where do I find my access token?” guidance to login, covering generated
  files, `DATA_DIR` overrides, and an operator-configured environment token.
- Provide useful credential-source/path guidance at startup on reused-token
  boots too. Environment-token guidance must not claim a token file was written.
- Align setup documentation and environment-example comments with actual defaults.
- Show workspace loading until a saved or server snapshot is available; surface
  connection failures and a retry action instead of presenting them as an empty
  workspace.

Primary files: `components/auth-gate.tsx`, `app/login/page.tsx`, workspace/sync
features, Serve startup/token modules, `.env.example`, and setup documentation.

Acceptance: a fresh local installation can start, find its token, and sign in
without prior knowledge of the codebase; existing-token restarts are equally
clear; login preserves deep links and never reveals the credential publicly.

Protect with focused auth/bootstrap tests, return-destination tests, and 401
reconnect-stop regression tests. Manually check fresh, returning, expired,
invalid-token, rate-limited, and unreachable-server states.

### UX2 — First board and required setup

Changes:

- Add the same **Start your first board** action to desktop and phone empty states.
- Add a focused **New board** panel: repository, editable title with a sensible
  default, selected/default model, and clearly explained review setting.
- List registered repositories directly. Offer the native local folder picker
  only when available; explain where that picker opens. A browser on another
  device must not imply it is selecting that device's filesystem.
- Check provider/model readiness in the creation flow. Reuse available
  credentials; show actionable setup guidance when none is ready.
- Move detailed provider setup into an accessible settings panel, full-screen
  on small devices. Keep host authentication tools explicitly labelled actions.
- Show creation progress/errors, preserve entered values, and focus/select the
  new board only after authoritative confirmation.

Primary files: focused modules under `features/onboarding` and
`features/boards`, existing header/provider/canvas/phone views, and current
project/provider routes. Extend shared contracts only for missing required data
such as a folder-picker capability; do not introduce a general setup framework.

Acceptance: the user can create the first board through a visible action, knows
where files will change, and can identify/fix a missing model before submitting.
Cancellation leaves no fabricated board; repeat clicks cannot create duplicates.

Protect repository authority, first/additional-board checkout behavior, cancelled
selection, missing-provider states, creation failure, and duplicate submissions.

### UX3 — Workspace, composer, and task control

Changes:

- Simplify the header and add a compact board switcher. Auto-focus the first board
  while retaining pan/zoom and persisted board positions.
- Show the composer destination (board, repository, branch) and model clearly.
  Use **Start task**; explain disabled/busy states and preserve failed submissions.
- Keep cards concise: task title, actual state, elapsed time, and latest activity.
  Open full activity and changed files in a task detail panel.
- Expose labelled **Stop** and **Change direction** actions. Explain continuation
  versus a forked session; make the latter update the authoritative board/session
  binding before subsequent work uses it.
- Show pending commands, meaningful failures, and successful server confirmation.
  Stop requests that return `accepted: false` must not appear successful.
- Replace implied percentage completion with observed activity and elapsed time.
- Remove inactive controls/shortcuts from the shipped interface or wire them to
  supported commands. Retire local-only dependency edges until durable dependency
  semantics are specified.

Primary files: header, composer, canvas, kanban/card modules, workspace command
handling, task routes/proxies, task/session modules, and contracts where required.

Acceptance: the destination is always identifiable, a task can be inspected and
controlled without searching menus, and every visible control has an action.

Protect prompt preservation, wrong-board prevention, busy state, abort failure,
redirect/fork binding, session continuity, and cosmetic drag reconciliation.

### UX4 — Decisions and result review

Changes:

- Make **Needs you** a workspace-wide list of pending requests and manual result
  reviews, including decisions on boards outside the viewport.
- Derive it from authoritative task state and `pendingApprovals`; preserve each
  request's identity when one task has several pending requests.
- Render permission scope with **Allow once** / **Deny**, actual questions with
  **Send answer**, and completed-result review with **Accept result** /
  **Request changes**. Do not infer request kinds from response text.
- Use existing request-scoped permission/question routes. Completed-result
  acceptance needs a minimal validated command if no suitable command exists:
  verify board/task/run identity, ensure no unresolved agent request remains,
  and persist its transition through the serialized store/projector.
- Do not send an implementation prompt merely to accept finished work. Requesting
  changes submits explicit follow-up work through normal task/session handling.
- Keep decisions visible while pending or failed. Remove them only after a
  confirming event; handle an item already resolved on another device gracefully.
- Present the result summary, task-scoped changed files, and precise revert /
  unrevert actions. Separate actual run evidence from inferred success.

Primary files: `features/approvals` and task-detail modules, kanban action hook,
question card, header/notification focus, task routes/store, shared contracts.

Acceptance: every waiting task is discoverable; the action matches its reason
for waiting; accepting a result does not restart implementation; failed or stale
decisions cannot silently disappear or change the wrong run.

Protect multiple pending requests, out-of-view boards, manual versus automatic
completion, acceptance validation/idempotency, stale decisions, and scoped revert.

### UX5 — Phone, recovery, and contextual options

Changes:

- Put pending decisions across boards first on phone, then running work and the
  selected board's stacked lanes. Preserve a reachable task composer.
- Use full-screen task/decision views, visible labels, usable touch targets, and
  keyboard-safe scrolling. Preserve focus when opening/closing panels.
- Offer optional approval alerts once work has started, and keep notification /
  voice settings discoverable. Browser support/configuration failures explain the
  next action; opt-in prompts follow explicit user interaction.
- Distinguish initial loading, empty state, stale/offline state, and server errors.
  Disable mutations against a disconnected/stale workspace while retaining drafts.
- Resume state and deep-linked decisions on return; recheck whether the decision
  still exists before showing its submit action.

Primary files: mobile lanes, task/decision panels, composer, connection strip,
notification/voice settings, and existing sync modules.

Acceptance: phone users can find and answer a decision across boards, reconnect
without losing a draft, and understand when displayed state is stale.

Protect deep-link focus, already-resolved notification targets, offline command
guards, draft preservation, recovery, and notification opt-in/support states.

## 6. Implementation discipline and validation

- Preserve commands over HTTP, state over the existing WebSocket, one server
  projector, schema-validated payloads, and serialized durable mutations.
- Put repeated command error/auth handling behind one small module interface;
  callers receive a typed result. Reuse existing sync authentication handling.
  Keep feature-specific commands at their domain seam; avoid a generic framework.
- Split the current large header and kanban files by settings, decisions, board
  navigation, and task details as those features change. Keep durable logic in
  Serve/shared contracts and temporary interaction state in Web.
- Read the bundled Next.js guides before App Router changes and use Context7 /
  primary documentation for library behavior during implementation.
- Each phase runs `bun run check`, `bun run check-types`, affected meaningful
  unit/integration tests, and relevant builds. Respect existing log/security gates.
- Automated browser E2E remains paused at the operator's request. Do not run
  `bun run e2e`, Playwright, or the E2E harness under this plan without the operator
  resuming it. Record browser acceptance as outstanding until it is actually done.
- Check process launch/cleanup behavior before resuming browser automation; the
  prior terminal-storm incident is unresolved acceptance evidence.
- Review desktop and phone flows, keyboard navigation/focus, readable contrast,
  touch targets, and loading/empty/error states. Do not mark a phase fully accepted
  from source inspection or unit tests alone.
- Commit each completed implementation phase atomically in dependency order when
  implementation/commits are authorized, with the required subject and body.

## 7. Planning validation and implementation prerequisite

Only this plan and its link in `implementation-plan.md` changed during planning.
No application source was modified, no test runner was launched, and no credential
value was read or displayed.

Checks on 2026-10-14:

- `bun run check`: passed; 272 files checked, no formatting fixes, log gate passed.
- `git diff --check` and the new plan's trailing-whitespace check: passed.
- `bun run check-types`: the root TypeScript step passed; Turbo then stopped
  with an “Access is denied” filesystem error.
- Invoking existing workspace type-check scripts directly passed for Web,
  contracts, Monaco, and voice. Serve and the OpenCode adapter reported
  `Request` / `Response` / `Headers` type errors; logger and Serve reported
  `PostHog.shutdown` missing from the installed type. These are current code /
  dependency-baseline issues; Markdown-only changes do not resolve them.
- No unit/integration test execution or browser E2E was performed for this
  documentation-only task.

Before starting UX source changes, establish a green type-check baseline and
resolve the Turbo filesystem failure. Keep any baseline repair separate from
UX behavior changes and record its actual cause and verification.

## 8. Completion criteria

A new operator can obtain access, select a repository, start a task, understand
where it runs, handle every decision, inspect/revert changes, and continue work.
A returning operator resumes the same authoritative workspace from desktop or
phone. Every visible control works, errors offer recovery, credentials remain
private, and unfinished acceptance checks are explicitly recorded.
