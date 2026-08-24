import {
  Ban,
  BookOpen,
  CheckSquare,
  Command,
  CornerUpRight,
  Mic,
  Network,
  Play,
  Shield,
  Workflow,
  XCircle,
  Zap,
} from "lucide-react";
import Link from "next/link";

export default function HelpPage() {
  return (
    <main className="relative h-full w-full overflow-y-auto overflow-x-hidden bg-[#0a0a0a] text-white">
      <div className="mx-auto max-w-5xl px-6 py-12">
        {/* Header */}
        <div className="mb-12">
          <Link
            className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-white"
            href="/"
          >
            <CornerUpRight className="h-4 w-4" />
            Back to Canvas
          </Link>
          <h1 className="mb-4 font-bold text-4xl">Chorus Help</h1>
          <p className="text-xl text-zinc-400">
            Infinite-canvas mission control for AI coding agents
          </p>
        </div>

        {/* What is Chorus */}
        <section className="mb-16">
          <div className="mb-6 flex items-center gap-3">
            <BookOpen className="h-6 w-6 text-blue-400" />
            <h2 className="font-semibold text-3xl">What is Chorus?</h2>
          </div>
          <div className="space-y-4 text-zinc-300 leading-relaxed">
            <p>
              <strong className="text-white">Chorus</strong> transforms how you
              work with AI coding agents. Instead of managing one chat with one
              agent, Chorus gives you a live operations floor where many tasks
              run in parallel.
            </p>
            <p>
              Every coding task becomes a{" "}
              <strong className="text-white">live card</strong> on a spatial
              canvas. Cards move through kanban states, stream agent output in
              real-time, and expose compact controls for approval, rejection,
              abort, and redirection.
            </p>
            <p className="border-blue-500 border-l-2 bg-blue-500/5 py-2 pl-4">
              <strong className="text-blue-400">The key insight:</strong> You're
              not replacing the coding agent—you're changing your relationship
              to it. You become the manager, agents become your workforce, and
              the canvas becomes your operations floor.
            </p>
          </div>
        </section>

        {/* Core Concepts */}
        <section className="mb-16">
          <h2 className="mb-6 font-semibold text-3xl">Core Concepts</h2>
          <div className="grid gap-6 md:grid-cols-2">
            {/* Task Cards */}
            <div className="rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-6">
              <div className="mb-3 flex items-start gap-3">
                <div className="mt-1">
                  <CheckSquare className="h-5 w-5 text-green-400" />
                </div>
                <div>
                  <h3 className="mb-2 font-semibold text-xl">Task Cards</h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    Each task is represented as a live card showing title,
                    prompt, assigned model, status, streaming output, and
                    controls. Cards pulse with activity and move between kanban
                    lanes as they progress.
                  </p>
                </div>
              </div>
            </div>

            {/* Kanban States */}
            <div className="rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-6">
              <div className="mb-3 flex items-start gap-3">
                <div className="mt-1">
                  <Workflow className="h-5 w-5 text-purple-400" />
                </div>
                <div>
                  <h3 className="mb-2 font-semibold text-xl">Kanban States</h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    Cards flow through states:{" "}
                    <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">
                      queue
                    </code>
                    ,{" "}
                    <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">
                      in_progress
                    </code>
                    ,{" "}
                    <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">
                      approve
                    </code>
                    , and{" "}
                    <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">
                      done
                    </code>
                    . Visual movement makes task state instantly clear.
                  </p>
                </div>
              </div>
            </div>

            {/* Dependency Chains */}
            <div className="rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-6">
              <div className="mb-3 flex items-start gap-3">
                <div className="mt-1">
                  <Network className="h-5 w-5 text-cyan-400" />
                </div>
                <div>
                  <h3 className="mb-2 font-semibold text-xl">
                    Dependency Chains
                  </h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    Connect tasks into automation flows. When an upstream task
                    completes, downstream tasks can auto-queue. Dependency wires
                    make complex workflows visible and manageable.
                  </p>
                </div>
              </div>
            </div>

            {/* Real-time Sync */}
            <div className="rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-6">
              <div className="mb-3 flex items-start gap-3">
                <div className="mt-1">
                  <Zap className="h-5 w-5 text-yellow-400" />
                </div>
                <div>
                  <h3 className="mb-2 font-semibold text-xl">Real-time Sync</h3>
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    State syncs over a live WebSocket connection so you can
                    watch and control the same session from desktop and mobile.
                    Every device sees the same live operations floor.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How to Control Tasks */}
        <section className="mb-16">
          <div className="mb-6 flex items-center gap-3">
            <Command className="h-6 w-6 text-purple-400" />
            <h2 className="font-semibold text-3xl">How to Control Tasks</h2>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-8">
            <div className="space-y-6">
              {/* Approve */}
              <div className="flex items-start gap-4">
                <div className="mt-1 rounded-lg bg-green-500/10 p-2">
                  <CheckSquare className="h-5 w-5 text-green-400" />
                </div>
                <div className="flex-1">
                  <h3 className="mb-1 font-semibold text-lg">Approve</h3>
                  <p className="text-sm text-zinc-400">
                    When a task needs permission or human confirmation, it moves
                    to the{" "}
                    <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">
                      approve
                    </code>{" "}
                    state. Click approve to let the agent continue.
                  </p>
                </div>
              </div>

              {/* Reject */}
              <div className="flex items-start gap-4">
                <div className="mt-1 rounded-lg bg-red-500/10 p-2">
                  <XCircle className="h-5 w-5 text-red-400" />
                </div>
                <div className="flex-1">
                  <h3 className="mb-1 font-semibold text-lg">Reject</h3>
                  <p className="text-sm text-zinc-400">
                    Stop a task that's going in the wrong direction. The task
                    will end and be marked as rejected, allowing you to start
                    fresh if needed.
                  </p>
                </div>
              </div>

              {/* Abort */}
              <div className="flex items-start gap-4">
                <div className="mt-1 rounded-lg bg-orange-500/10 p-2">
                  <Ban className="h-5 w-5 text-orange-400" />
                </div>
                <div className="flex-1">
                  <h3 className="mb-1 font-semibold text-lg">Abort</h3>
                  <p className="text-sm text-zinc-400">
                    Immediately halt a running task. Use this when you need to
                    stop execution urgently, such as when the agent is
                    performing unintended actions.
                  </p>
                </div>
              </div>

              {/* Redirect */}
              <div className="flex items-start gap-4">
                <div className="mt-1 rounded-lg bg-blue-500/10 p-2">
                  <CornerUpRight className="h-5 w-5 text-blue-400" />
                </div>
                <div className="flex-1">
                  <h3 className="mb-1 font-semibold text-lg">Redirect</h3>
                  <p className="text-sm text-zinc-400">
                    Send corrective instructions to a running task. You can
                    provide new context or change direction without losing the
                    work already completed.
                  </p>
                </div>
              </div>

              {/* Model Races */}
              <div className="flex items-start gap-4">
                <div className="mt-1 rounded-lg bg-purple-500/10 p-2">
                  <Play className="h-5 w-5 text-purple-400" />
                </div>
                <div className="flex-1">
                  <h3 className="mb-1 font-semibold text-lg">Model Races</h3>
                  <p className="text-sm text-zinc-400">
                    Run the same task with multiple models side-by-side. Compare
                    outputs, latency, and quality to pick the best result or
                    learn which model works best for specific tasks.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Technology Stack */}
        <section className="mb-16">
          <h2 className="mb-6 font-semibold text-3xl">Technology Stack</h2>
          <div className="grid gap-4 text-sm">
            <div className="rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-4">
              <div className="flex items-start gap-3">
                <Zap className="mt-0.5 h-5 w-5 text-yellow-400" />
                <div>
                  <h3 className="mb-1 font-semibold">OpenCode SDK</h3>
                  <p className="text-zinc-400">
                    Powers agent execution. Chorus stays attached to real coding
                    agents instead of pretending to be one.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-4">
              <div className="flex items-start gap-3">
                <Network className="mt-0.5 h-5 w-5 text-cyan-400" />
                <div>
                  <h3 className="mb-1 font-semibold">Live WebSocket Sync</h3>
                  <p className="text-zinc-400">
                    Shared state plane for real-time replication across all
                    devices. Ensures every client sees the same authoritative
                    state.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-4">
              <div className="flex items-start gap-3">
                <Shield className="mt-0.5 h-5 w-5 text-green-400" />
                <div>
                  <h3 className="mb-1 font-semibold">ArmorIQ</h3>
                  <p className="text-zinc-400">
                    Policy plane that defines what actions agents can perform.
                    Shows both allowed and blocked actions with clear reasons.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-4">
              <div className="flex items-start gap-3">
                <Workflow className="mt-0.5 h-5 w-5 text-purple-400" />
                <div>
                  <h3 className="mb-1 font-semibold">Superplane</h3>
                  <p className="text-zinc-400">
                    Workflow plane for orchestrating task graphs, approval-gated
                    automation, branching, and downstream queuing.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-4">
              <div className="flex items-start gap-3">
                <Mic className="mt-0.5 h-5 w-5 text-pink-400" />
                <div>
                  <h3 className="mb-1 font-semibold">ElevenLabs</h3>
                  <p className="text-zinc-400">
                    Voice feedback plane for announcing important moments like
                    approval requests, failures, or completions.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Key Principles */}
        <section className="mb-16">
          <h2 className="mb-6 font-semibold text-3xl">Key Principles</h2>
          <div className="space-y-4 rounded-lg border border-zinc-800 bg-[#0f0f0f]/90 p-8 text-zinc-300">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 font-mono text-blue-400 text-sm">→</span>
              <p className="text-sm">
                <strong className="text-white">Local-first execution:</strong>{" "}
                Your laptop bridge owns agent execution. Clients observe and
                control it.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 font-mono text-blue-400 text-sm">→</span>
              <p className="text-sm">
                <strong className="text-white">
                  Human override always wins:
                </strong>{" "}
                Any automated workflow must yield to abort, reject, or redirect
                commands.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 font-mono text-blue-400 text-sm">→</span>
              <p className="text-sm">
                <strong className="text-white">Mobile is first-class:</strong>{" "}
                Remote approval and task interruption work from any device, not
                just desktop.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 font-mono text-blue-400 text-sm">→</span>
              <p className="text-sm">
                <strong className="text-white">
                  Visibility over automation:
                </strong>{" "}
                You should see what the agent is allowed to do, what was
                blocked, and why.
              </p>
            </div>
          </div>
        </section>

        {/* Getting Started */}
        <section className="mb-16">
          <h2 className="mb-6 font-semibold text-3xl">Getting Started</h2>
          <div className="space-y-4 text-zinc-300 leading-relaxed">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
              <ol className="list-inside list-decimal space-y-4">
                <li className="text-sm">
                  <strong className="text-white">Open Chorus</strong> and land
                  on the infinite canvas
                </li>
                <li className="text-sm">
                  <strong className="text-white">Create a task card</strong>{" "}
                  from the prompt input at the bottom
                </li>
                <li className="text-sm">
                  <strong className="text-white">Watch it stream</strong> live
                  output as the agent works
                </li>
                <li className="text-sm">
                  <strong className="text-white">Approve when needed</strong> if
                  the task requires permission
                </li>
                <li className="text-sm">
                  <strong className="text-white">Connect tasks</strong> to
                  create automation flows and dependency chains
                </li>
              </ol>
            </div>
            <p className="mt-4 text-sm text-zinc-400">
              Remember: Chorus is about managing many agents at once, not
              replacing them. Think of it as your operations control center for
              AI-powered development.
            </p>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-zinc-800 border-t pt-8">
          <div className="flex items-center justify-between text-sm text-zinc-500">
            <p>
              For more details, see{" "}
              <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
                context/chorus-implementation-plan.md
              </code>
            </p>
            <Link
              className="text-blue-400 transition-colors hover:text-blue-300"
              href="/"
            >
              Back to Canvas
            </Link>
          </div>
        </footer>
      </div>
    </main>
  );
}
