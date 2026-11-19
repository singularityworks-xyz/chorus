import { proxyChorusJson } from "@/lib/chorus-serve";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ boardId: string; taskId: string }> }
) {
  const { boardId, taskId } = await params;
  return proxyChorusJson(
    `/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/retry`,
    { method: "POST" }
  );
}
