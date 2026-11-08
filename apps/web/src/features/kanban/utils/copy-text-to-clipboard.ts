export async function copyTextToClipboard(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined
): Promise<void> {
  if (!clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable.");
  }

  await clipboard.writeText(text);
}
