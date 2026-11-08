import { proxyChorusJson } from "@/lib/chorus-serve";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ boardId: string; command: string }> }
) {
  const { boardId, command } = await params;
  return proxyChorusJson(
    `/boards/${encodeURIComponent(boardId)}/session/history/${encodeURIComponent(command)}`,
    { method: "POST" }
  );
}
