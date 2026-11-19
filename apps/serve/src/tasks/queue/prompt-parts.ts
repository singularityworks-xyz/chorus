import type { QueueBoardPromptInput } from "@chorus/contracts";
import { resolveInside } from "../../paths/sandbox";
import { taskLogger as logger } from "../logger";

type SdkPart =
  | { text: string; type: "text" }
  | { filename: string; mime: string; type: "file"; url: string };

function resolveFilePath(rawPath: string, directory: string): string {
  try {
    return resolveInside(directory, rawPath);
  } catch (error) {
    if (error instanceof Error) {
      logger.warn("file-part-rejected", { reason: error.name });
    }
    throw error;
  }
}

export function convertPartsToSdk(
  parts: NonNullable<QueueBoardPromptInput["parts"]>,
  directory: string
): SdkPart[] {
  return parts.flatMap((part) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text ?? "" };
    }
    if (part.type === "file") {
      const resolvedPath = resolveFilePath(part.path ?? "", directory);
      const fileUrl = `file://${resolvedPath}`;
      const rangeParams = part.lineRange
        ? `?start=${part.lineRange.start}&end=${part.lineRange.end}`
        : "";
      logger.debug("file-part-resolved", {
        rawPath: part.path,
        resolvedPath,
        fileUrl,
        filename: part.filename,
        mime: part.mime,
        isDirectory: part.isDirectory,
      });
      return {
        type: "file" as const,
        filename: part.filename ?? "",
        mime: part.isDirectory
          ? "application/x-directory"
          : (part.mime ?? "text/plain"),
        url: fileUrl + rangeParams,
      };
    }
    return [];
  });
}
