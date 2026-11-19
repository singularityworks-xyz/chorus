import type { OpenCodeBridge } from "../bridge/opencode/bridge";

type Session = Awaited<ReturnType<OpenCodeBridge["getSession"]>>;
type SessionMessages = Awaited<ReturnType<OpenCodeBridge["sessionMessages"]>>;

export interface BoardTaskBridge {
  abortSession(sessionId: string, directory?: string): Promise<boolean>;
  createSession(
    input: Parameters<OpenCodeBridge["createSession"]>[0]
  ): Promise<{ id: string }>;
  forkSession(
    input: Parameters<OpenCodeBridge["forkSession"]>[0]
  ): Promise<{ id: string }>;
  getSession(
    input: Parameters<OpenCodeBridge["getSession"]>[0]
  ): Promise<
    Pick<Session, "directory" | "id"> & Partial<Pick<Session, "revert">>
  >;
  promptSession(
    input: Parameters<OpenCodeBridge["promptSession"]>[0]
  ): Promise<unknown>;
  promptSessionAsync(
    input: Parameters<OpenCodeBridge["promptSessionAsync"]>[0]
  ): Promise<unknown>;
  revertSession(sessionId: string, directory?: string): Promise<unknown>;
  sessionMessages(
    sessionId: string,
    directory: string
  ): Promise<{ info: { role: SessionMessages[number]["info"]["role"] } }[]>;
  subscribeDirectory(directory: string): Promise<void>;
  unrevertSession(sessionId: string, directory?: string): Promise<unknown>;
  waitForSessionIdle(
    sessionId: string,
    directory: string,
    timeoutMs: number
  ): Promise<boolean>;
}
