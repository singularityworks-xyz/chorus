import { proxyChorusJson } from "@/lib/chorus-serve";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ boardId: string; taskId: string }> }
) {
  const { boardId, taskId } = await params;
  return proxyChorusJson(
    `/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/finalize-review`,
    {
      body: await request.text(),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
}
