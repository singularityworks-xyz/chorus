import { describe, expect, test } from "bun:test";
import { VoiceService } from "./service";

const RUN_REAL_API =
  process.env.RUN_REAL_API_TESTS === "true" &&
  Boolean(process.env.GROQ_API_KEY);

describe.skipIf(!RUN_REAL_API)("Groq Voice Service", () => {
  describe("TTS — text to speech", () => {
    test("generates wav audio from text", async () => {
      const service = new VoiceService();
      const text = "Hello from Chorus, the AI agent orchestration platform.";

      const result = await service.generateSpeech({
        type: "task_summary",
        text,
      });

      expect(result.status).toBe("generated");
      expect(result.audioBuffer).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.mimeType).toBe("audio/wav");
      expect(result.audioBase64).toBeDefined();
      expect((result.audioBuffer as ArrayBuffer).byteLength).toBeGreaterThan(0);
    });

    test("truncates text over 200 characters", async () => {
      const service = new VoiceService();
      const longText = "A".repeat(300);

      const result = await service.generateSpeech({
        type: "task_summary",
        text: longText,
      });

      expect(result.status).toBe("generated");
      expect(result.audioBuffer).toBeDefined();
    });

    test("uses custom voice when provided", async () => {
      const service = new VoiceService();
      const text = "This is a test with a custom voice.";

      const result = await service.generateSpeech({
        type: "task_summary",
        text,
        voiceId: "troy",
      });

      expect(result.status).toBe("generated");
      expect(result.audioBuffer).toBeDefined();
    });
  });

  describe("STT — speech to text", () => {
    test("transcribes wav audio", async () => {
      const service = new VoiceService();

      const ttsResult = await service.generateSpeech({
        type: "task_summary",
        text: "This is a test of speech to text transcription.",
      });

      expect(ttsResult.status).toBe("generated");
      expect(ttsResult.audioBuffer).toBeDefined();

      const sttResult = await service.transcribeSpeech({
        audioBuffer: ttsResult.audioBuffer as ArrayBuffer,
      });

      expect(sttResult.text.length).toBeGreaterThan(0);
      expect(sttResult.text.toLowerCase()).toContain("test");
    });

    test("transcribes with word timestamps", async () => {
      const service = new VoiceService();

      const ttsResult = await service.generateSpeech({
        type: "task_summary",
        text: "Testing word timestamps.",
      });

      const sttResult = await service.transcribeSpeech({
        audioBuffer: ttsResult.audioBuffer as ArrayBuffer,
      });

      expect(sttResult.text.length).toBeGreaterThan(0);
      if (sttResult.words) {
        expect(sttResult.words.length).toBeGreaterThan(0);
        expect(sttResult.words[0]).toHaveProperty("word");
        expect(sttResult.words[0]).toHaveProperty("start");
        expect(sttResult.words[0]).toHaveProperty("end");
      }
    });
  });

  describe("Streaming TTS", () => {
    test("streams audio data", async () => {
      const service = new VoiceService();
      const text = "This is a streaming test.";

      const stream = await service.streamSpeech({
        type: "task_summary",
        text,
      });

      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          chunks.push(value);
        }
      }

      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      expect(totalLength).toBeGreaterThan(0);
    });
  });

  describe("Round-trip — TTS then STT", () => {
    test("text to speech back to text preserves content", async () => {
      const service = new VoiceService();
      const originalText = "Hello world, this is a round-trip test.";

      const ttsResult = await service.generateSpeech({
        type: "task_summary",
        text: originalText,
      });

      expect(ttsResult.status).toBe("generated");

      const sttResult = await service.transcribeSpeech({
        audioBuffer: ttsResult.audioBuffer as ArrayBuffer,
      });

      expect(sttResult.text.length).toBeGreaterThan(0);

      const similarity = calculateSimilarity(
        originalText
          .toLowerCase()
          .replace(/[.,!?]/g, "")
          .trim(),
        sttResult.text
          .toLowerCase()
          .replace(/[.,!?]/g, "")
          .trim()
      );

      expect(similarity).toBeGreaterThan(0.5);
    });
  });
});

function calculateSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;

  if (longer.length === 0) {
    return 1;
  }

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
