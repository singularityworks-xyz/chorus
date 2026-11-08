import {
  acceptedCommandResponseSchema,
  apiErrorSchema,
} from "@chorus/contracts";

export async function requireAcceptedCommand(
  response: Response,
  {
    fallback,
    rejectedMessage = "The server did not accept this request. Refresh the board and retry.",
  }: {
    fallback: string;
    rejectedMessage?: string;
  }
): Promise<void> {
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(payload);
    throw new Error(error.success ? error.data.message : fallback);
  }

  const accepted = acceptedCommandResponseSchema.safeParse(payload);
  if (!accepted.success) {
    throw new Error(
      "The server returned an invalid command acknowledgment. Refresh the board before retrying."
    );
  }
  if (!accepted.data.accepted) {
    throw new Error(rejectedMessage);
  }
}
