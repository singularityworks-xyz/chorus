import { z } from "zod";

const HEALTH_PATH = "/global/health";

const healthPayloadSchema = z.object({
  healthy: z.boolean(),
  version: z.string().optional(),
});

export type OpenCodeHealth = z.infer<typeof healthPayloadSchema>;

export async function probeOpenCodeHealth(
  baseUrl: string,
  timeoutMs: number,
  authorization?: string
): Promise<OpenCodeHealth | null> {
  try {
    const headers = new Headers();
    if (authorization) {
      headers.set("authorization", authorization);
    }
    const response = await fetch(new URL(HEALTH_PATH, baseUrl), {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }

    const payload: unknown = await response.json();
    const result = healthPayloadSchema.safeParse(payload);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
