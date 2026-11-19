import posthog from "posthog-js";
import { removeLineRange } from "@/lib/line-range";
import {
  fetchCommands,
  fetchDirectory,
  fetchFiles,
  fetchSkills,
  type OpencodeFileNode,
} from "@/lib/opencode-client";
import type { AutocompleteItem } from "../types";
import {
  createCommandItems,
  fuzzyMatchFiles,
  sortFilesByDepthAndFrecency,
} from "./autocomplete-search";

export async function loadFileItems(
  boardId: string,
  query: string,
  dirPath: string | undefined,
  signal: AbortSignal
): Promise<AutocompleteItem[]> {
  let rawItems: AutocompleteItem[];
  if (dirPath || query.includes("/")) {
    const pathToFetch = dirPath ?? query.slice(0, query.lastIndexOf("/") + 1);
    const nodes = await fetchDirectory(boardId, pathToFetch || "/", { signal });
    posthog.capture("autocomplete_fetch_directory", {
      dirPath: pathToFetch,
      count: nodes.length,
    });
    const filterTerm = dirPath ? "" : query.slice(query.lastIndexOf("/") + 1);
    rawItems = nodes
      .filter((node: OpencodeFileNode) =>
        node.name.toLowerCase().includes(filterTerm.toLowerCase())
      )
      .map((node: OpencodeFileNode) => ({
        id: node.path,
        label: node.name,
        description: node.type === "directory" ? "Directory" : "File",
        type: "file" as const,
        isDirectory: node.type === "directory",
        path: node.path,
      }));
  } else {
    const cleanQuery = removeLineRange(query);
    const files = await fetchFiles(boardId, cleanQuery, { signal });
    posthog.capture("autocomplete_fetch_files", {
      query: cleanQuery,
      count: files.length,
    });
    rawItems = files.map((file: string) => ({
      id: file,
      label: file.split("/").pop() ?? file,
      description: file,
      type: "file" as const,
      isDirectory: false,
      path: file,
    }));
  }

  const fuzzyResults = fuzzyMatchFiles(rawItems, query.replace("#", ""));
  return sortFilesByDepthAndFrecency(fuzzyResults);
}

function firstRejectedResult(
  results: PromiseSettledResult<unknown>[]
): PromiseRejectedResult | undefined {
  for (const result of results) {
    if (result.status === "rejected") {
      return result;
    }
  }
  return undefined;
}

export async function loadCommandItems(
  boardId: string | undefined,
  query: string,
  signal: AbortSignal
): Promise<{
  error: PromiseRejectedResult | undefined;
  items: AutocompleteItem[];
}> {
  const commandsPromise = boardId
    ? fetchCommands(boardId, { signal })
    : Promise.reject(new Error("Select a board to load commands."));
  const skillsPromise = boardId
    ? fetchSkills(boardId, { signal })
    : Promise.reject(new Error("Select a board to load skills."));
  const [commandsResult, skillsResult] = await Promise.allSettled([
    commandsPromise,
    skillsPromise,
  ]);
  const commands =
    commandsResult.status === "fulfilled" ? commandsResult.value : [];
  const skills = skillsResult.status === "fulfilled" ? skillsResult.value : [];

  posthog.capture("autocomplete_fetch_commands", {
    count: commands.length,
    commands: commands.map((command) => command.name),
  });
  posthog.capture("autocomplete_fetch_skills", {
    count: skills.length,
    skills: skills.map((skill) => skill.name),
  });

  return {
    error: firstRejectedResult([commandsResult, skillsResult]),
    items: createCommandItems(query, commands, skills),
  };
}
