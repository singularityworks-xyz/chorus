# Chorus core functionality implementation plan

Date: 8 November 2026. Status: implementation in progress. The roadmap below was created before code changes began; this progress record distinguishes landed slices from production gates that still need work.

## Execution progress

| Slice | State | Evidence / remaining gate |
| --- | --- | --- |
| Application-wide provider and default model | Implemented; provider error handling and status wording hardened in the current slice | Settings stores one shared default; board prompts inherit it. Configured-provider status now reads through the pinned OpenCode SDK global-config API, matching the global write path. SDK config reads/updates fail explicitly instead of looking successful with missing data; filesystem config/auth summaries distinguish missing files from unreadable or invalid contents. Settings describes OpenCode's provider credential state as Authenticated (not Live), and suppresses empty/zero claims when status loading fails. Cross-engine propagation and migration coverage remain open in Phase 2. |
| Board autocomplete, remote access, and failure recovery | Implemented in the current working slice | File, directory, command, and skill lookups now use an authenticated board-scoped Chorus proxy and the board's authorized worktree. Adapter and web boundaries normalize and validate payloads; 120 ms debounce, abort, and request IDs reduce work and prevent stale results; partial command results survive, and lookup failures stay visible with Retry. Manual browser checks covered file results and selection, repository-specific `/undo` help, rejected path traversal, retry, and recovery after the error. Focused adapter, route, and client tests pass (38 tests, 110 assertions). Playwright runtime was not used for this slice at the user's request; its desktop/mobile regression spec is present but remains a CI/browser gate. |
| Saved prompts and terminal outcomes | Implemented and committed | Task prompts are retained, and failed/timed-out outcomes remain visible and retryable. |
| Board commands and graceful UI feedback | Core flow implemented and committed; follow-ups committed in `ece240a`, `25b6d3c`, and `6ee1cfd` | Run, Retry, approval, question, and diff commands validate acknowledgments; failures stay visible and preserve input. A board permits one live task. Typed and autocomplete `/undo` and `/redo` show an actionable composer error and preserve the prompt when rejected. Response copy now waits for clipboard success and announces success or a manual-copy fallback; icon-only output and remove controls have accessible labels. Manual/Auto review changes share optimistic state across desktop and mobile, show a pending state, and restore the prior value with visible recovery guidance when the server rejects the mutation. Board removal waits for the server state event, keeps the board visible when rejected, and reports a retryable error. New Task and Delete shortcuts now act on the selected board; unimplemented A/R review shortcuts are no longer advertised. The inert composer More button was removed; voice, Send, and attachment removal now have accessible names. Broader board-control browser verification remains pending. Stop follows the explicit board/task lifecycle below. |
| Manual plan review lifecycle | Implemented and committed | Finalize and Reject target the board/task; finalization restores task ownership, uses the task's saved model and Build agent, persists edited plan/answers, and leaves failures retryable. Review policy is task-scoped for current records with a legacy board-mode fallback. Focused run: 175 tests, 0 failures, 398 assertions across 5 files. |
| Stop lifecycle | Implemented and committed | Desktop and mobile Stop controls call an explicit board/task command; HTTP, legacy HTTP, and WebSocket entry points converge on the same service. The control is available as soon as a task enters the active lane, including before its first provider event. The service waits for confirmed engine idle, records only the targeted task as aborted, treats an already-idle run as normal completion, and preserves active state with an actionable error when the engine refuses or cannot confirm the stop. Focused service run: 126 tests, 0 failures, 318 assertions across 5 files; first-event UI coverage: 2 tests, 0 failures. Broader browser coverage remains pending. |
| Board repository history | Implemented and committed in `596c1a3`, `9715600`, and `a50b0fa` | Board Undo/Redo and composer `/undo`/`/redo` target one explicit board session through serialized server commands. Availability follows OpenCode session revert state, board/provider idleness, and session ownership; task cards and lane state remain historical. Service and HTTP coverage passed, including stale completed-task pointers. Browser coverage is added, but local Playwright did not reach assertions because the production `next build` produced no output; first green CI run remains pending. |
| Question response safeguards | Implemented in the current working slice | Empty fetch results now show an explicit stale-request state with a retry action instead of hiding the card. Answer submission validates every question, rejects stale option indices and blank required answers, and preserves choices when the command fails. Focused validation covers missing, custom, stale, multi-question, and unanswerable cases. |
| Stream presentation | Initial fixes implemented | Removed fabricated sample output before the first event, stabilized streamed row identities, and limited expanded live Markdown refreshes to 100 ms intervals so each arriving chunk does not reparse the entire transcript. Stream grouping/identity and first-event behavior have focused tests. Performance profiling, replay/load coverage, auto-follow behavior, and expanded-content retention remain pending. |
| Board editor menu | Placeholder actions removed | The menu now exposes diff review, which has a real server-backed result. Opening a folder in an OS editor is not supported by the web app. |
| Validation | Partial | Latest `bun run check` and `bun run check-types` pass across all 9 packages. The current provider-settings hardening and project-route suites pass: 27 tests, 55 assertions across adapter config, service, config storage, credential storage, and routes. Browser control confirmed provider Settings reports an actionable engine-connection error and exposes Retry; after the UI fix it no longer reports zero providers or an empty authentication state when the request failed, and unavailable metrics display as unknown. Retry remained visibly failed because the local engine is unavailable, and no settings were changed. The autocomplete adapter, HTTP-route, and client suites pass: 38 tests, 110 assertions. Manual browser verification also passed for file lookup/selection, `/undo` help, path traversal rejection, retry visibility, recovery, composer accessible names, and attachment removal; test composer state was cleared afterward. A desktop/mobile autocomplete Playwright spec was added and discovery passed, but its runtime was not run at the user's request. Existing board control Playwright specs remain unexecuted locally because the production `next build` has stalled before browser setup; first green CI remains pending. The full `bun test` run completed with 943 passed, 17 skipped, and 22 failed across 982 tests; failures were environment-bound: sandboxed port-0 listeners, inaccessible `~/.chorus`, macOS `/var` versus `/private/var` path expectations, and unavailable local PostHog collection. Production-browser coverage now includes board Undo/Redo, composer parity, unchanged task history, busy history recovery, rejected review-mode recovery, New Task keyboard focus, board-removal rejection, and autocomplete failure recovery. Earlier focused runs passed: board-task-service and history routes (68 tests, 200 assertions), question/approval/history/server (72 tests, 197 assertions), stream/history/output (14 tests, 37 assertions), broader route/task/WebSocket/projector/history/output (133 tests, 342 assertions), and broader command/projector/event suite (175 tests, 398 assertions). |

No phase is considered production-complete until its acceptance gate passes. The implementation work is still subject to the remaining migration, browser, engine-compatibility, load, and recovery gates below.

## Intended result

Configure the provider once in application Settings. Every existing and newly created board uses that configuration automatically. Board controls issue real, validated commands, accurately display their outcome, and recover predictably from failures. Agent output streams smoothly without losing text, duplicating events, resetting expanded content, or making the rest of the application sluggish.

“Global” means one Chorus installation and its authorized connected devices. It does not mean sharing credentials across independent installations or organizations. Repository roots, worktrees, session ownership, and execution permissions remain board-specific.

## Findings that drive the plan

These are source observations unless explicitly identified as a runtime observation. They are not claims that all possible failures have been reproduced.

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Provider configuration already has a global write path, but status and setup are coupled to the selected directory. Configuration and authentication reload only that directory. | `apps/serve/src/projects/service.ts`, `packages/opencode-adapter/src/features/config/config-manager.ts`, `apps/web/src/components/app-header.tsx` | Fix the application-wide source of truth and propagation across the engine pool; moving a Settings control alone will not fix inheritance. |
| Models are loaded again when the selected board directory changes; boards persist a provider/model pair. Returning to the default option does not clear the persisted board selection in the current change handler. | `apps/web/src/components/prompt-input.tsx` | Make default resolution explicit, invalidate catalogs after Settings changes, and cover returning to the application default. |
| Run and Retry buttons render without click handlers. Create Task only focuses the shared composer. | `apps/web/src/features/kanban/components/kanban.tsx` | Implement real commands and bind Create Task to the board containing the button. |
| Approve changes columns before finalization succeeds; Reject removes the card before abort succeeds. Failures are reported through telemetry without restoring truthful state. | `apps/web/src/features/kanban/hooks/use-kanban-card-actions.ts` | Replace durable-looking local transitions with pending command state and authoritative server events. |
| The shared review handlers send finalization/abort regardless of the kind of pending approval. Permission-specific endpoints already exist. | The action hook above and `apps/serve/src/routes/index.ts` | Separate plan review, permission requests, questions, and stop commands; route each by its request identity. |
| Header Undo/Redo read transient lane history while composer commands call OpenCode session revert/unrevert, so the same labels changed different state. | `use-kanban-card-actions.ts`, `kanban-card-node.tsx`, `features/workspace/provider.tsx` | Route both controls through a board-scoped OpenCode session operation. Preserve task cards as historical records and report busy, unavailable, ownership, and provider errors visibly. |
| Stop and question actions do not consistently check HTTP status. Question retrieval is a separate one-time fetch and errors can look like an empty question list. | `agent-output-card.tsx`, `question-card.tsx` | Use typed command results and pending requests from the shared state stream. |
| Before this repair, diff and autocomplete failures could look like empty results, and autocomplete requests went directly to a browser-local OpenCode URL. | `apps/web/src/lib/opencode-client.ts` | Autocomplete now uses the authenticated board-scoped Chorus adapter path, schema validation, request cancellation, and visible errors/retry. The broader diff helper still needs its own failure-shape audit. |
| Open in Editor includes placeholder file contents; its local/here handlers require a behavior audit. | `apps/web/src/features/kanban/components/kanban-card-node.tsx` | Implement real file/editor capabilities or expose an explicitly unavailable action with a reason. |
| Stream output groups adjacent steps, and some React keys include changing group length or content. | `agent-output-card.tsx`, `kanban.tsx`, `utils/group-steps.ts` | Profile rendering and use stable identities to preserve expansion, selection, and scroll state. |
| WebSocket delivery already has a 100 ms coalescing window, bounded buffering, backpressure, sequence accounting, replay, and reconnect reconciliation. | `apps/serve/src/ws/hub.ts`, `apps/serve/src/bridge/opencode/bridge.ts` | Extend and tune these mechanisms; preserve ordering and replay invariants. |
| Live lifecycle completion depends on an environment flag and provider credentials; the mobile project excludes the agent lifecycle suite. CI currently does not run Playwright. | `e2e/agent.e2e.ts`, `playwright.config.ts`, `.github/workflows/ci.yml` | Add deterministic full-lifecycle browser coverage and make it a required CI gate. |
| Playwright configuration documents an earlier development-mode hydration problem. | `playwright.config.ts` | Reproduce it on the installed versions and resolve it if present; passing a production build alone does not prove development buttons work. |
| The currently open board displayed Error and an aborted task; Settings named the selected repository and offered board-specific reload instructions. | Read-only inspection of `http://localhost:3000/` | Include actionable session recovery and board-independent Settings in acceptance testing. |

Focused baseline executed: **152 passed, 0 failed, 334 assertions across 9 files**. Suites covered board task service, session watchdog, card lifecycle, bridge behavior, event bursts, WebSocket hub, adapter normalization, adapter reconnection, and the frontend reducer. This does not establish that UI controls or live provider execution work end to end.

Existing uncommitted engine/process changes were present when planning began. Preserve them and coordinate any implementation that touches those files.

## Product and architecture decisions

1. **One active provider and one application default model.** Settings is usable before the first board exists. Stored credentials may include multiple providers, but one is active for board execution. Boards do not have provider setup or provider overrides.
2. **Optional model selection stays within the active provider.** Retain the existing model choice only as an optional override within that provider. “Use application default” clears the override. Historical runs retain their actual provider/model. A provider switch resets incompatible board overrides to inheritance and reports that migration once.
3. **Settings changes affect subsequent runs.** An active run keeps its resolved provider/model and configuration version. Never restart it merely to refresh settings. Apply changes to idle engines safely and to newly allocated engines before their next dispatch. If the installed SDK cannot update configuration without disrupting work, defer that engine update until idle and show the pending state.
4. **HTTP commands, one WebSocket state channel.** The server validates, persists, and projects lifecycle changes. HTTP responses acknowledge commands; `/ws` delivers durable state. Use snapshots through the existing synchronization protocol for bootstrap/recovery, not a competing state channel after each click.
5. **One executing run per board.** Preserve the current submit-and-start behavior. An eligible queued card can be started through Run using the same server operation. While the board is busy, show an explicit unavailable/busy state and retain the draft; introducing a multi-task scheduler is outside this repair. Independent boards retain bounded concurrency through the existing engine pool.
6. **Separate lane, run outcome, session health, and command status.** Retain the existing lanes `queue`, `in_progress`, `approve`, `done`. Use shared typed run outcomes such as `succeeded`, `failed`, `aborted`, `timed_out`; a card in Done must not imply success. Waiting for a human is distinct from a stalled engine. Pending UI commands are not lifecycle transitions.
7. **Every command targets explicit identities.** Carry board, task, run/attempt, session, and request IDs as applicable. Resolve checkout paths on the server. Late events from an older attempt cannot mutate a replacement attempt.
8. **Scope stays on core functionality.** No new provider failover, multi-provider races, orchestration system, dependency editor, or unrelated visual redesign. Existing supported redirect/fork behavior must remain correct and receive regression coverage.

## Delivery sequence

Implement each phase as a small reviewable change with its own tests and rollback notes. A phase is complete only when its acceptance gate passes. Tests accompany implementation throughout.

### Phase 0 — Reproduction, fixtures, and compatibility checks

Deliverables:

- Record every visible board/Settings control, its intended action, supported platforms, pending state, and current test coverage. Include mouse, keyboard, and touch paths.
- Build reproducible fixtures for empty, queued, running, waiting for permission, waiting for questions, plan review, successful, failed, aborted, and timed-out tasks.
- Extend the existing test harness with a deterministic OpenCode-compatible HTTP/event fixture behind the adapter boundary. Exercise real Chorus routes, persistence, WebSockets, and UI; do not fake success only in the browser.
- Capture baseline latency, render commits, frame counts, snapshot frequency, reconnect time, and bounded-buffer/memory behavior.
- Verify OpenCode **1.19.0** SDK and binary behavior for global config writes, credential visibility across processes, instance disposal, model resolution, and event reconciliation. Inspect installed SDK types and the running engine's API specification. Current online docs are supplementary, since they can describe a newer release.
- Reproduce the documented development hydration issue with a minimal controlled input and button. Compare development and production output; diagnose the actual failure before changing framework configuration or versions.

Gate: deterministic fixtures reproduce the known inert controls, review failure behavior, and cross-board provider propagation gaps. Baseline measurements and SDK compatibility results are recorded.

### Phase 1 — Shared command contracts and graceful failure handling

Primary locations: `packages/contracts/src`, dedicated command/error modules in `apps/serve/src`, and feature-specific API clients in `apps/web/src`.

Deliverables:

- Define schema-derived command acknowledgments, safe error payloads, typed error codes, retryability, optional retry-after information, and correlation IDs. Preserve HTTP distinctions such as 401, 403, 409, 422, 429, 503, and 504.
- Centralize Elysia error translation and Next.js proxy handling. Malformed JSON and invalid payloads return useful validation errors; unexpected faults return a safe message and correlation ID.
- Replace success-shaped fallbacks such as `[] as unknown as T` with discriminated results. Validate both request and response boundaries. A 200 response with `accepted: false` is still a failed command.
- Add a reusable command hook/client with request cancellation, deadlines, pending state, repeated-click prevention, and visible recovery. Retry reads with capped backoff; mutation retries require a durable command ID.
- Extend existing mutation receipts for task/control operations. Record dispatch intent and reconcile ambiguous engine outcomes before resending. Do not claim exactly-once execution across an external engine unless its API supplies the necessary guarantee.
- Preserve the user's prompt, attachments, plan edits, and answers on failure. An expired Chorus session follows the existing login flow; expired provider authorization offers a Settings recovery action.
- Add route/board render boundaries using the installed Next.js API. Handle async action failures explicitly: render boundaries do not catch ordinary event-handler failures.
- Keep logs structured and correlated across HTTP, dispatch, engine events, store commits, and WS delivery. Redact credentials, authorization codes, raw provider bodies, and prompt/file content from routine telemetry.

Tests: error mapping, malformed payloads, non-JSON upstream responses, false acknowledgments, timeouts, cancellation, duplicate IDs, lost HTTP responses, 401 handling, and persistence failure. Include browser assertions that failures are visible and user input survives.

Gate: a command cannot silently fail, appear successful on a rejected response, or remain pending indefinitely. Cosmetic optimism rolls back safely; durable lifecycle state follows server events.

### Phase 2 — Application-wide provider settings and safe migration

Primary locations: a focused `apps/serve/src/providers/` feature, `packages/opencode-adapter`, shared contracts, a new `apps/web/src/features/settings/` feature, and the existing engine registry integration.

Deliverables:

- Extract provider/configuration/authentication orchestration from `ProjectService` and the large app header. Keep raw SDK interactions in the adapter.
- Introduce board-independent endpoints to read Settings/catalogs, connect or reauthenticate supported providers, select the active provider/default model, and refresh status. Preserve existing API compatibility during the transition.
- Reuse supported global OpenCode credential/config storage. Keep the Chorus active selection and configuration generation in durable installation settings; do not copy secrets into workspace snapshots, board records, localStorage, logs, or repository files.
- Make credential/config readers distinguish absent files, invalid contents, permission errors, and unsupported formats. Verify JSONC support through the SDK instead of relying on the current JSON-only file reader. Preserve unknown settings and unrelated providers.
- Track desired versus applied configuration generation per managed engine. Invalidate shared model catalogs when it changes. Idle engines refresh safely; engines allocated later inherit before accepting work. Partial propagation is visible and retryable.
- Ensure the server resolves an explicit eligible model for each new run. Project configuration must not silently override Chorus's chosen provider. If project policy disallows it, return an actionable configuration conflict; do not edit the repository or weaken its policy.
- Remove the requirement to select a board to configure or authenticate a provider. Offer supported in-app API/OAuth flows; retain terminal-based fallback only where the host can actually perform it. Local editor/auth actions must explain remote-device limitations.
- Distinguish stored, configured, authenticated, selected, and verified states. Avoid calling a provider “Live” merely because it exists in a catalog. A connection check must have a bounded outcome and must not secretly start a paid generation.
- Implement an idempotent migration. Reuse a valid explicit global default first; otherwise use a single unambiguous valid prior selection. If prior boards disagree and no valid default exists, ask for one choice in global Settings. Never request configuration separately on each board.
- Preserve historical models and task transcripts; migrate only future selection/overrides. Retain a backup/version marker and avoid destructive credential removal. Distinguish changing the active provider from disconnecting stored credentials.

Tests: no boards; multiple repositories/worktrees; already-running and newly allocated engines; server restart; custom XDG locations; malformed/JSONC config; API and OAuth success/failure/cancellation; invalid/expired credentials; project-level conflicts; concurrent Settings writes; partial engine refresh; returning to default; provider switch during a run; migration rerun; remote browser and second-device convergence.

Gate: configure once, execute successfully from at least two different boards and a newly created board, reload/restart, and execute again without any board-specific provider step. Existing work is not interrupted by a Settings change.

### Phase 3 — Server-owned task lifecycle and recovery

Primary locations: `apps/serve/src/tasks`, `apps/serve/src/routes`, workspace persistence/projectors, and `packages/contracts`.

Deliverables:

- Define a transition table with preconditions for submit/start, execution, plan review, permission wait, question wait, completion, failure, stop, timeout, retry, and redirect/fork.
- Persist full canonical task input and attempt identity separately from display titles and thinking steps. Include prompt parts, attachment references, agent, resolved model, configuration generation, and retry lineage. Never reconstruct a retry from truncated card text.
- Reuse existing per-board operation serialization and engine limits. Reject cross-board task/session references and simultaneous invalid starts with explicit conflicts.
- Make start/Run and Retry first-class commands. Start dispatches an eligible queued card once. Retry creates a linked new attempt, preserving the previous outcome and transcript; it uses the current application configuration, visibly stated in the UI. Revalidate referenced files before dispatch.
- Persist acceptance before execution can outrun card creation. Handle crash points before dispatch, after engine acceptance, before acknowledgment, and before terminal projection. Reconcile ambiguous attempts instead of blindly launching duplicate work.
- Separate plan finalization from permission approval and question replies. Resolve a specific pending request, verify it still exists, and make duplicate or stale responses harmless or clearly conflicting. Manual plan finalization must enter the correct execution agent with the resolved model, rather than leaving the session in plan mode.
- Stop remains “Stopping” until the engine confirms idle/abort. If stop cannot be confirmed, keep the run visibly uncertain/recovering and retain a safe retry action. Rejecting a permission does not mean deleting the whole task.
- Make watchdog behavior activity-aware and state-aware. A quiet tool, reconnect, or human approval wait must not be mistaken for a confirmed failure. Use bounded health checks and explicit inactivity/deadline policy.
- On restart, reconcile active sessions, pending approvals/questions, and task outcomes before declaring the board ready. Preserve the existing rule that board removal waits for a safe execution/checkout outcome and never destroys dirty worktrees.

Tests: table-driven transition tests; request/run identity checks; duplicate terminal events; delayed events from prior attempts; double submit/start/stop/retry; two devices acting at once; every dispatch crash point; manual versus automatic review; multiple pending requests; watchdog waits; active/dirty board removal; restart recovery.

Gate: every accepted attempt has an observable durable state and reaches either a truthful terminal outcome or an explicit recoverable state. No duplicate run, lost request, phantom approval, or cross-board mutation occurs in the fault fixtures.

### Phase 4 — Wire every board control to its intended behavior

Primary locations: focused board action hooks/components, `features/workspace`, `features/canvas`, and `features/kanban`. Split large files by feature as they are touched; avoid a broad cosmetic rewrite.

| Control | Required behavior | Required verification |
| --- | --- | --- |
| Create Task | Select/focus the owning board and focus its composer; preserve drafts when switching. | Click board B while board A is selected; submission targets B on desktop and mobile. |
| Submit / Enter | Validate input, target the selected board, show acceptance/pending, clear only after durable acceptance. | Empty prompt, attachments, rapid Enter/click, busy board, offline, lost response. |
| Run | Start an eligible queued task through the server start operation. | Exactly one dispatch; disabled with a reason during dispatch or another active run. |
| Retry | Start one linked attempt from persisted task input using the current application default. | Failed/aborted/timed-out outcomes, long prompts, attachments, changed provider, repeat click. |
| Stop | Send stop to the correct attempt and wait for confirmation. | Success, HTTP rejection, timeout, already-ended run, reconnect during stop. |
| Plan Finalize / Reject | Submit edited plan and answers to the correct lifecycle command. | Failure retains edits and lane; success moves only after server events; duplicate taps are safe. |
| Permission Approve / Reject | Resolve the exact request with the intended scope; do not send plan text or generic abort. | Multiple requests, stale request, explicit denial, two clients answering concurrently. |
| Question Submit / Reject | Render pending requests from synchronized state; validate required answers and submit per request. | Single/multiple choice, custom answer, multiple requests without answer collisions, failed send and recovery. |
| Manual / Auto review | Persist a typed mode with clear timing semantics; changing mode affects subsequent work and does not silently approve existing requests. | Both layouts, reload, failed save, change during active run. |
| Model selector / Default | Choose only eligible models within the global provider; Default clears the optional board override. | Settings update without switching boards, model removal, stale catalog, reload. |
| Undo / Redo and slash commands | Use one board-scoped server operation against the board's OpenCode session; keep task cards and lanes as historical work. | Never affect a different board; failure is visible; active work is blocked; repository conflicts can be refreshed and retried. |
| Diff / file selection | Show the actual session/attempt diff, meaningful empty state, or actionable load error. | No changes, changed files, invalid session, failed fetch, retry, close/reopen. |
| Open here / Open locally | Open actual authorized file content or the intended host editor. | No placeholder content; remote host limitations explicit; unavailable capability disabled with reason. |
| Expand / collapse / copy | Preserve expansion and scroll during streaming; copy actual content and show clipboard errors. | New chunks, grouped steps, permission-denied clipboard, keyboard operation. |
| Close / remove board | Use the existing lifecycle-safe removal path; retain the board when stop/cleanup cannot complete. | Running board, dirty worktree, double click, failure, switching focus afterward. |
| Drag / reorder / resize / zoom / fit | Keep cosmetic interactions responsive and persisted where intended; validate lifecycle-sensitive moves on the server. | Click versus drag, nested controls, failed drag persistence, touch, keyboard, layout/reload. |

Also inventory header/menu controls encountered in the board flow. A visible unsupported action must state its limitation instead of looking executable and doing nothing.

Use shared capability/precondition selectors for button availability in both desktop and mobile views, with the server enforcing the same constraints. Pending status is scoped to the command's actual board/task/request. Bind actions to their own IDs instead of whichever board becomes selected later. Preserve user drafts during incoming stream updates.

Gate: every row has a browser test asserting the resulting state or artifact, not just that a button can be clicked. Exercise keyboard/focus, accessible names, nested React Flow drag/scroll behavior, and mobile touch targets. Remove the mobile lifecycle exclusion after fixing its selection/input path.

### Phase 5 — Stream correctness and measured performance

Primary locations: adapter normalization, the OpenCode bridge, workspace projectors/store, WebSocket hub/protocol, sync reducer, and stream rendering components.

Deliverables:

- Preserve stable source/message/part/tool identities and run boundaries. Test deltas before metadata, full-part updates after deltas, duplicate replay, Unicode, interleaved tools, final replacements, and out-of-order recovery.
- Verify the provider's actual reasoning capability. Render only reasoning or progress the engine emits. If none is available, show an accurate activity state rather than fabricated thinking text or an endless spinner.
- Preserve the existing lossless coalescing and contiguous sequence ranges. Terminal events and human-control requests flush earlier buffered text before delivery. Reconnect/resync must recover any skipped display patches.
- Profile the durable write path separately from network coalescing: sending fewer WS frames does not automatically reduce SQLite/projector work. Optimize persistence batching only if measurement warrants it, while preserving atomic event commits, receipts, and replay order.
- Use stable render keys based on persistent group/step IDs. Preserve object identity for unaffected boards, scope subscriptions narrowly, and memoize expensive grouping/rendering where profiling demonstrates a benefit.
- Avoid reparsing large Markdown and remounting editors on every chunk. Use bounded incremental presentation and lazy-load heavy diff/editor views. Virtualize or page long transcripts only where needed, with access to the full retained output.
- Follow the output only while the user is near the end; retain their position while inspecting history. Add a clear jump-to-latest control. Keep expanded blocks expanded across updates.
- Bound in-memory event queues, reconnect buffers, and retained normalization tracking. Apply the existing retention policy deliberately and test its limits; do not silently truncate active output.
- Surface stream status separately from run status: connecting, receiving, reconnecting/reconciling, waiting, completed, and failed must not collapse into one ambiguous Error or Thinking indicator.

Proposed acceptance budgets, to calibrate and freeze after Phase 0 on named hardware and fixed fixtures:

| Measurement | Initial target |
| --- | --- |
| Local pending feedback after a control interaction | p95 within 100 ms on desktop; 200 ms under the mobile test profile. |
| Normalized event received by Chorus to visible output | p95 within 250 ms in the local fixture; excludes provider generation/network latency. |
| Server commit to visible terminal/approval state | p95 within 250 ms; earlier text must remain ordered. |
| Application-owned command to durable acknowledgment | p95 within 1 second without engine boot/provider work; longer operations show progress and have explicit deadlines. |
| Bounded stream load | Five boards, one active run per board, 100 deltas/second aggregate for 10 minutes; 500 deltas/second aggregate for a 10-second burst; include a 1 MiB transcript. |
| Correctness under load | Zero missing/duplicated final text, misrouted events, stale terminal transitions, or lost approval requests; no full-snapshot loop during normal streaming. |
| UI responsiveness under load | Composer and controls remain usable; no stream-attributable main-thread task over 100 ms in the fixed desktop benchmark. Record mobile results separately. |
| Recovery after network/engine is healthy | Visible convergence within 5 seconds after reconnection/reconciliation, with startup time measured separately. |
| Memory/queue behavior | Queues stay within configured limits and fixed-workload repetitions stabilize after cleanup; no monotonically growing orphan subscriptions or tracking maps in a 30-minute soak. |

These are implementation targets, not measurements already achieved. Correctness gates take precedence over meeting a latency target by dropping state.

Gate: baseline comparison demonstrates the agreed budgets, stable UI state, and byte-for-byte final transcript equality across normal delivery, replay, and restart.

### Phase 6 — End-to-end resilience, CI, and rollout

Required scenario matrix:

| Stage | Happy path | Failure/recovery path |
| --- | --- | --- |
| First launch / global setup | Configure before boards; create two boards; both execute. | Missing provider, failed auth, malformed config, unavailable engine; one global recovery path. |
| Board creation / selection | Open repository, create worktree-backed board, switch/reopen. | Folder cancellation, unauthorized/deleted directory, worktree failure; no orphan board/session. |
| Task acceptance / start | Prompt and attachments produce one card and one run. | Invalid input, duplicate request, busy board, storage failure, lost response. |
| Active stream | Thinking/progress, tools, edits, response remain coherent. | Empty reasoning, interrupted SSE, dropped WS, backpressure, delayed/repeated chunks. |
| Human control | Plan finalization, permissions, questions, review mode. | Stale request, partial answers, concurrent responses, provider failure while resuming. |
| Terminal state | Accurate success, failure, abort, timeout, diff summary. | Late events, stop failure, watchdog false positive, engine exits before final event. |
| Subsequent work | Follow-up, retry, undo/redo, board reopen. | Changed provider/model, invalid attachment, missing session, repository conflicts. |
| Recovery / synchronization | Reload, server restart, network return, second device. | Expired/revoked session, missed events, stale cursor, interrupted Settings propagation. |
| Layout / input | Desktop, mobile, keyboard, touch, reduced motion. | Nested drag swallowing clicks, overflow, focus loss, composer hidden by keyboard. |

Test layers and gates:

- **Unit:** schema validation, model/default resolution, migration rules, transition/capability tables, grouping identity, error mapping, idempotency and watchdog policy.
- **Integration:** real workspace persistence and HTTP/WS plumbing against the deterministic engine fixture; failpoints around dispatch/commit; provider generation propagation; restart/replay and bounded-load tests.
- **Browser:** production build plus real serve, desktop and mobile, with deterministic full lifecycle and control coverage. Keep `.e2e.ts` naming so Bun and Playwright do not load each other's suites. Add a small development hydration/input smoke separately.
- **Real engine compatibility:** run the pinned OpenCode binary against a controlled local provider endpoint for provider/model/config and streaming compatibility. A mock engine alone cannot prove this boundary.
- **Live provider smoke:** separately verify supported API-key/OAuth paths and a small real run in a controlled environment with authorized credentials and bounded cost. Never make ordinary PR coverage depend on personal credentials. Missing credentials is recorded as unverified, not reported as a pass.
- **Fault/soak:** disconnect SSE and WS independently; restart engine and serve at each lifecycle stage; test rate limits, 401/403, 429/retry-after, provider 5xx, disk errors, two tabs/devices, long-running tools and human waits.

Required implementation checks: `bun run check`, `bun run check-types`, relevant targeted tests, `bun test`, `bun run build`, and `bun run e2e`. Note that `bun run check` runs an autofixer: inspect its diff and preserve unrelated work. Add deterministic browser and compatibility jobs to CI and the aggregate result gate; retain traces/screenshots/log correlation on failure. Distinguish flaky passes from clean passes and do not use increased retries as the fix.

Rollout:

1. Introduce additive/versioned contracts and backward-compatible readers first, including old snapshot handling. Gate unsupported old clients with an explicit refresh requirement when necessary.
2. Back up/version existing settings and task data; dry-run and test migrations on representative old state. Keep schema changes additive through the rollback window.
3. Land provider inheritance, lifecycle commands, controls, and stream optimization in separately revertible phases. Capture measurements and migration notes with each phase.
4. Use a controlled release/canary to run the complete acceptance matrix, including at least two boards and a second device. Review command failures, unresolved runs, reconnect loops, propagation failures, and stream lag.
5. Roll back application code and restore prior desired settings if correctness regresses. Reconcile pending commands before redispatch after rollback. Do not restore credentials destructively or rerun completed attempts.
6. Use repository commit subjects `<type>[<AREA>]: <summary>` with descriptive bodies. Wait for clean CI and merge normally with a merge commit; keep each phase individually revertible.

Gate: all mandatory deterministic checks pass without lifecycle skips; live integration evidence is recorded; no visible no-op board actions remain; migration and rollback have been exercised.

## Completion checklist

- [ ] One provider configured in Settings works across old, new, reopened, and restarted boards.
- [ ] Settings works with zero boards and propagates to all authorized views.
- [ ] Active work survives provider changes; later attempts use the intended configuration.
- [ ] Every board control has an explicit supported behavior, pending state, failure state, and browser test.
- [ ] Plans, approvals, questions, aborts, retries, and redirects target the correct request/run/board.
- [ ] Failed commands preserve user input and do not fabricate lifecycle success.
- [ ] Undo/redo is board-specific, reads OpenCode revert state, and never mutates historical task cards or lane state.
- [ ] Stream content is complete, ordered, replay-safe, and responsive under the agreed load.
- [ ] Reconnect/restart restores truthful state without duplicate execution.
- [ ] Desktop and mobile complete the full lifecycle; production and development input paths work.
- [ ] Required lint, type, test, build, browser, compatibility, and migration gates pass.
- [ ] Release evidence includes baseline comparison, known limitations, and a tested rollback procedure.

## Documentation constraints and references

Context7 was not exposed among the tools available during this planning session. Before implementation, use Context7 if available and verify each touched library against the installed version. No framework upgrades are required by this plan.

The installed Next.js guides were read directly:

- `apps/web/node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md`: distinguishes expected action errors from render exceptions and documents this installed version's recovery APIs.
- `apps/web/node_modules/next/dist/docs/01-app/02-guides/testing/playwright.md`: recommends testing production output and describes browser-based E2E integration.

Official online references checked:

- [OpenCode configuration](https://opencode.ai/docs/config/): global and project configuration have precedence rules; inheritance must be validated against the pinned binary rather than assumed.
- [OpenCode server API](https://docs.opencode.ai/docs/server/): distinguishes provider authentication, instance management, session operations, and SSE events.
- [React Flow performance](https://reactflow.dev/learn/advanced-use/performance): recommends stable/memoized components and callbacks and avoiding broad node subscriptions.
- [Elysia error handling](https://elysiajs.com/patterns/error-handling): provides custom error/validation handling and production-safe error detail behavior.
- [Playwright retries](https://playwright.dev/docs/test-retries): distinguishes clean, flaky, and failed outcomes; the release gate should retain that distinction.
