import { proxyChorusJson } from "@/lib/chorus-serve";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ deviceId: string }> }
) {
  const { deviceId } = await context.params;
  return proxyChorusJson(`/auth/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
}
