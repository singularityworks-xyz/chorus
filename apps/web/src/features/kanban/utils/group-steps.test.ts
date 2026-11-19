import { describe, expect, test } from "bun:test";
import type { AgentStep } from "@/features/kanban/components/agent-output-card";
import { groupSteps } from "./group-steps";

function makeStep(
  id: string,
  kind: AgentStep["kind"],
  content: string,
  status: AgentStep["status"] = "done"
): AgentStep {
  return {
    content,
    id,
    kind,
    status,
    summary: kind === "thinking" ? "Thinking" : kind,
  };
}

describe("groupSteps", () => {
  test("keeps a streamed group identity stable while its text grows", () => {
    const initial = groupSteps([
      makeStep("think-1", "thinking", "Inspecting the request", "running"),
    ]);
    const updated = groupSteps([
      makeStep(
        "think-1",
        "thinking",
        "Inspecting the request and repository",
        "running"
      ),
    ]);

    const initialGroup = initial[0];
    const updatedGroup = updated[0];
    expect(initialGroup?.kind).toBe("thinking");
    expect(updatedGroup?.kind).toBe("thinking");
    if (
      initialGroup?.kind !== "thinking" ||
      updatedGroup?.kind !== "thinking"
    ) {
      return;
    }

    expect(initialGroup.id).toBe("think-1");
    expect(updatedGroup.id).toBe(initialGroup.id);
    expect(updatedGroup.content).toBe("Inspecting the request and repository");
  });

  test("keeps tool boundaries and later thinking groups in stream order", () => {
    const grouped = groupSteps([
      makeStep("think-1", "thinking", "First thought"),
      makeStep("command-1", "command", "bun test"),
      makeStep("think-2", "thinking", "Second thought"),
      makeStep("response-1", "response", "The answer"),
    ]);

    expect(
      grouped.map((group) =>
        group.kind === "thinking" || group.kind === "response"
          ? `${group.kind}:${group.id}`
          : `${group.kind}:${group.step.id}`
      )
    ).toEqual([
      "thinking:think-1",
      "command:command-1",
      "thinking:think-2",
      "response:response-1",
    ]);
  });

  test("preserves every fragment and the running state in a large thinking stream", () => {
    const fragments = Array.from(
      { length: 4096 },
      (_, index) => `reasoning fragment ${index.toString().padStart(4, "0")}`
    );
    const steps = fragments.map((content, index) =>
      makeStep(
        `thought-${index}`,
        "thinking",
        content,
        index === fragments.length - 1 ? "running" : "done"
      )
    );

    const grouped = groupSteps(steps);
    expect(grouped).toHaveLength(1);

    const group = grouped[0];
    expect(group?.kind).toBe("thinking");
    if (group?.kind !== "thinking") {
      return;
    }

    expect(group.id).toBe("thought-0");
    expect(group.sourceSteps).toHaveLength(fragments.length);
    expect(group.status).toBe("running");
    expect(group.content).toBe(fragments.join("\n\n"));
  });

  test("does not invent thinking content before an event arrives", () => {
    expect(groupSteps([])).toEqual([]);
  });
});
