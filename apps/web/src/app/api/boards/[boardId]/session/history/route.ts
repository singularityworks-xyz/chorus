import { proxyChorusJson } from "@/lib/chorus-serve";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ boardId: string }> }
) {
  const { boardId } = await params;
  return proxyChorusJson(
    `/boards/${encodeURIComponent(boardId)}/session/history`,
    { method: "GET" }
  );
}
