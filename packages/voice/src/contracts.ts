import { z } from "zod";

export const VoiceNotificationTypeEnum = z.enum([
  "approval_needed",
  "task_blocked",
  "task_failed",
  "task_completed",
  "task_summary",
]);

export type VoiceNotificationType = z.infer<typeof VoiceNotificationTypeEnum>;

export const VoiceNotificationPriorityEnum = z.enum(["high", "normal", "low"]);

export type VoiceNotificationPriority = z.infer<
  typeof VoiceNotificationPriorityEnum
>;

export const GroqTtsVoiceEnum = z.enum([
  "autumn",
  "diana",
  "hannah",
  "austin",
  "daniel",
  "troy",
]);

export type GroqTtsVoice = z.infer<typeof GroqTtsVoiceEnum>;

export const GROQ_TTS_VOICES: Array<{
  id: GroqTtsVoice;
  name: string;
  gender: string;
}> = [
  { id: "autumn", name: "Autumn", gender: "Female" },
  { id: "diana", name: "Diana", gender: "Female" },
  { id: "hannah", name: "Hannah", gender: "Female" },
  { id: "austin", name: "Austin", gender: "Male" },
  { id: "daniel", name: "Daniel", gender: "Male" },
  { id: "troy", name: "Troy", gender: "Male" },
];

export const VoiceNotificationRequestSchema = z.object({
  type: VoiceNotificationTypeEnum,
  priority: VoiceNotificationPriorityEnum.default("normal"),
  cardId: z.string().optional(),
  projectId: z.string().optional(),
  text: z.string().min(1).max(5000),
  voiceId: z.string().optional(),
  modelId: z.string().optional(),
});

export type VoiceNotificationRequest = z.input<
  typeof VoiceNotificationRequestSchema
>;

export const VoiceNotificationResultSchema = z.object({
  id: z.string(),
  status: z.enum(["generated", "failed"]),
  audioBuffer: z.instanceof(ArrayBuffer).optional(),
  audioBase64: z.string().optional(),
  mimeType: z.string().optional(),
  error: z.string().optional(),
  generatedAt: z.date(),
});

export type VoiceNotificationResult = z.infer<
  typeof VoiceNotificationResultSchema
>;

export const SpeechToTextRequestSchema = z.object({
  audioBuffer: z.instanceof(ArrayBuffer),
  modelId: z.string().optional(),
  diarize: z.boolean().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
});

export type SpeechToTextRequest = z.infer<typeof SpeechToTextRequestSchema>;

export const SpeechToTextResultSchema = z.object({
  text: z.string(),
  confidence: z.number().optional(),
  words: z
    .array(
      z.object({
        word: z.string(),
        start: z.number(),
        end: z.number(),
        confidence: z.number().optional(),
      })
    )
    .optional(),
});

export type SpeechToTextResult = z.infer<typeof SpeechToTextResultSchema>;

export const VoiceSettingsSchema = z.object({
  muteAll: z.boolean().optional().default(false),
  mobileOnly: z.boolean().optional().default(false),
  desktopOnly: z.boolean().optional().default(false),
  approvalsOnly: z.boolean().optional().default(false),
  failuresOnly: z.boolean().optional().default(false),
  narrationMode: z.enum(["concise", "verbose"]).optional().default("concise"),
});

export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;
