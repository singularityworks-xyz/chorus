import { useCallback, useRef, useState } from "react";
import { transcribeSpeech } from "@/lib/voice-api";

interface UseVoiceRecordingReturn {
  error: string | null;
  isRecording: boolean;
  isTranscribing: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
}

export function useVoiceRecording(
  onTranscriptionComplete: (text: string) => void
): UseVoiceRecordingReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const handleTranscription = useCallback(
    async (blob: Blob) => {
      if (blob.size === 0) {
        setError("Recording was empty");
        return;
      }

      try {
        setIsTranscribing(true);
        const result = await transcribeSpeech(blob);
        onTranscriptionComplete(result.text);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to transcribe audio";
        setError(message);
      } finally {
        setIsTranscribing(false);
      }
    },
    [onTranscriptionComplete]
  );

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
  }, []);

  const handleRecordingStop = useCallback(
    async (mediaRecorder: MediaRecorder) => {
      setIsRecording(false);
      cleanupStream();

      const blob = new Blob(chunksRef.current, {
        type: mediaRecorder.mimeType,
      });
      chunksRef.current = [];

      await handleTranscription(blob);
    },
    [cleanupStream, handleTranscription]
  );

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/ogg";

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to access microphone";
      setError(message);
    }
  }, []);

  const stopRecording = useCallback((): Promise<void> => {
    if (
      !mediaRecorderRef.current ||
      mediaRecorderRef.current.state === "inactive"
    ) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const mediaRecorder = mediaRecorderRef.current;
      if (!mediaRecorder) {
        resolve();
        return;
      }

      mediaRecorder.onstop = async () => {
        await handleRecordingStop(mediaRecorder);
        resolve();
      };

      mediaRecorder.stop();
    });
  }, [handleRecordingStop]);

  return {
    isRecording,
    isTranscribing,
    error,
    startRecording,
    stopRecording,
  };
}
