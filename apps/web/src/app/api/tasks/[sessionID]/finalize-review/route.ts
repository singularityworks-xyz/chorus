export function POST() {
  return Response.json(
    {
      code: "task_identity_required",
      message: "Refresh the board and submit plan review from its task card.",
    },
    { status: 409 }
  );
}
