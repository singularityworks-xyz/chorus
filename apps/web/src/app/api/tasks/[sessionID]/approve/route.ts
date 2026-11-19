import { proxyChorusJson } from "@/lib/chorus-serve";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionID: string }> }
) {
  const { sessionID } = await params;
  return proxyChorusJson(`/tasks/${encodeURIComponent(sessionID)}/approve`, {
    method: "POST",
    body: JSON.stringify(await request.json()),
  });
}
