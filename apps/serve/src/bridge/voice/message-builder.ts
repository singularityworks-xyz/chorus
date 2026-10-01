import type {
  VoiceNotificationRequest,
  VoiceNotificationType,
  VoiceSettings,
} from "@chorus/voice";

const APPROVAL_MESSAGES: Record<string, string> = {
  default: "Task requires your approval. Please review and take action.",
  concise: "Approval needed.",
};

const BLOCKED_MESSAGES: Record<string, string> = {
  default:
    "Task has been blocked. Please check the details and decide next steps.",
  concise: "Task blocked.",
};

const FAILED_MESSAGES: Record<string, string> = {
  default:
    "A task has failed. Please review the error and determine how to proceed.",
  concise: "Task failed.",
};

const COMPLETED_MESSAGES: Record<string, string> = {
  default:
    "A task has completed successfully. All downstream dependencies are being processed.",
  concise: "Task completed.",
};

const MESSAGE_MAP: Record<VoiceNotificationType, Record<string, string>> = {
  approval_needed: APPROVAL_MESSAGES,
  task_blocked: BLOCKED_MESSAGES,
  task_failed: FAILED_MESSAGES,
  task_completed: COMPLETED_MESSAGES,
  task_summary: {
    default: "Task summary available.",
    concise: "Summary ready.",
  },
};

export function buildNotificationMessage(
  type: VoiceNotificationRequest["type"],
  settings: VoiceSettings,
  customText?: string
): string {
  if (customText && customText.trim().length > 0) {
    return customText.trim();
  }

  const mode = settings.narrationMode ?? "concise";
  const messages = MESSAGE_MAP[type];

  return messages[mode] ?? messages.default ?? "Notification received.";
}

export function shouldPlayNotification(
  settings: VoiceSettings,
  type: VoiceNotificationRequest["type"]
): boolean {
  if (settings.muteAll) {
    return false;
  }

  if (settings.approvalsOnly) {
    return type === "approval_needed";
  }

  if (settings.failuresOnly) {
    return type === "task_failed" || type === "task_blocked";
  }

  return true;
}
