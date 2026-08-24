import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    GROQ_API_KEY: z.string().optional(),
    GROQ_TTS_DEFAULT_MODEL_ID: z
      .string()
      .min(1)
      .default("canopylabs/orpheus-v1-english"),
    GROQ_TTS_DEFAULT_VOICE: z.string().min(1).default("hannah"),
    GROQ_STT_MODEL_ID: z.string().min(1).default("whisper-large-v3-turbo"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
