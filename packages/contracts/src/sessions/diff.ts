import { z } from "zod";

const DRIVE_PATH_PATTERN = /^[A-Za-z]:/;

/** A file change returned by an agent session in the shape the web client renders. */
export const sessionFileDiffSchema = z
  .object({
    additions: z.number().int().nonnegative(),
    after: z.string(),
    before: z.string(),
    deletions: z.number().int().nonnegative(),
    file: z
      .string()
      .min(1)
      .max(4096)
      .refine((file) => {
        const path = file.replaceAll("\\", "/");
        return !(
          path.startsWith("/") ||
          DRIVE_PATH_PATTERN.test(path) ||
          path.split("/").some((part) => part === ".." || part === "")
        );
      }, "file must be a relative path inside the project"),
  })
  .strict();

export const sessionFileDiffsSchema = z
  .array(sessionFileDiffSchema)
  .max(10_000);

export type SessionFileDiff = z.infer<typeof sessionFileDiffSchema>;
