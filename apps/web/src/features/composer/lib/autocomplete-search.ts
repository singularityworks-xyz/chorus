import fuzzysort from "fuzzysort";
import { boostByFrecency } from "@/lib/frecency";
import type { OpencodeCommand, OpencodeSkill } from "@/lib/opencode-client";
import type { AutocompleteItem } from "../types";

export function fuzzyMatchFiles(
  items: AutocompleteItem[],
  query: string
): AutocompleteItem[] {
  if (!query) {
    return items;
  }

  const targets = items.map((item) => ({
    item,
    displayValue: item.path ?? item.label,
    description: item.description ?? "",
  }));

  const results = fuzzysort.go(query, targets, {
    keys: ["displayValue", "description"],
    limit: 50,
    threshold: -10_000,
  });

  return results.map((r) => r.obj.item);
}

export function sortFilesByDepthAndFrecency(
  items: AutocompleteItem[]
): AutocompleteItem[] {
  const withDepth = items.map((item) => ({
    item,
    depth: (item.path ?? item.label).split("/").filter(Boolean).length,
  }));

  withDepth.sort((a, b) => {
    if (a.item.isDirectory !== b.item.isDirectory) {
      return a.item.isDirectory ? -1 : 1;
    }
    const depthDiff = a.depth - b.depth;
    if (depthDiff !== 0) {
      return depthDiff;
    }
    return a.item.label.localeCompare(b.item.label);
  });

  return boostByFrecency(withDepth.map((d) => d.item));
}

export function createCommandItems(
  query: string,
  commands: OpencodeCommand[],
  skills: OpencodeSkill[]
): AutocompleteItem[] {
  const builtinCommands = [
    { name: "undo", description: "Undo the last repository change" },
    { name: "redo", description: "Redo a repository change" },
  ];
  const allItems: AutocompleteItem[] = [
    ...builtinCommands
      .filter((command) =>
        command.name.toLowerCase().includes(query.toLowerCase())
      )
      .map((command) => ({
        id: `builtin:${command.name}`,
        label: `/${command.name}`,
        description: command.description,
        type: "command" as const,
      })),
    ...commands
      .filter((command) =>
        command.name.toLowerCase().includes(query.toLowerCase())
      )
      .map((command) => ({
        id: `cmd:${command.name}`,
        label: `/${command.name}`,
        description: command.description ?? "",
        type: "command" as const,
      })),
    ...skills
      .filter((skill) => skill.name.toLowerCase().includes(query.toLowerCase()))
      .map((skill) => ({
        id: `skill:${skill.name}`,
        label: `/${skill.name}`,
        description: skill.description ?? "",
        type: "skill" as const,
      })),
  ];

  return fuzzysort
    .go(query.toLowerCase(), allItems, {
      keys: ["label", "description"],
      limit: 50,
      threshold: -10_000,
    })
    .map((result) => result.obj);
}
