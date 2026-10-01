/**
 * `@chorus/contracts` — the single typed language shared by `apps/serve` and
 * `apps/web`.
 *
 * Module layout:
 * - `base.ts`    — domain schemas (repo, board, card, step, snapshot, mutations)
 * - `events.ts`  — `WorkspaceEvent`, the vocabulary persisted in the event log
 * - `protocol.ts` — `/ws` wire envelopes and control-event classification
 * - `projector.ts` — pure `applyEventToBoard`, the only board reducer that exists
 *
 * `base.ts` is separate from this barrel on purpose: `events.ts` needs the base
 * schemas at module-evaluation time, so a direct `events.ts` ↔ `index.ts`
 * cycle would leave those zod schemas in the temporal dead zone. Nothing may
 * import from `index.ts` internally — import the specific module instead.
 */

// biome-ignore lint/performance/noBarrelFile: package entry point from package.json `exports` — both apps import `@chorus/contracts` as one specifier by design.
export * from "./base";
export * from "./events";
export * from "./mutation-map";
export * from "./projector";
export * from "./protocol";
