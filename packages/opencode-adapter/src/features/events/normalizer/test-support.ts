import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";

export function assistantMessageUpdated(sessionID: string, messageID: string) {
  return {
    id: `evt-${messageID}`,
    type: "message.updated",
    properties: {
      sessionID,
      info: { id: messageID, role: "assistant" },
    },
  } as OpencodeEvent;
}
