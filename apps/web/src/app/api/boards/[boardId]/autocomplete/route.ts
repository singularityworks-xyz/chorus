import { proxyChorusJson } from "@/lib/chorus-serve";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ boardId: string }> }
) {
  const { boardId } = await params;
  const query = new URL(request.url).searchParams.toString();
  const suffix = query ? `?${query}` : "";
  return proxyChorusJson(
    `/boards/${encodeURIComponent(boardId)}/autocomplete${suffix}`,
    { method: "GET" }
  );
}
