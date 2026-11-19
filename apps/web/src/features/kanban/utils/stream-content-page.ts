export const STREAM_CONTENT_PAGE_CHARS = 8 * 1024;

const PARAGRAPH_BOUNDARY_DRIFT_CHARS = 1024;

export interface StreamContentRange {
  end: number;
  start: number;
}

export function getLatestStreamContentRange(
  content: string
): StreamContentRange {
  const end = content.length;
  let start = Math.max(0, end - STREAM_CONTENT_PAGE_CHARS);

  if (start > 0) {
    const paragraphBreak = content.indexOf("\n\n", start);
    const paragraphStart = paragraphBreak + 2;
    if (
      paragraphBreak >= 0 &&
      paragraphStart < end &&
      paragraphStart - start <= PARAGRAPH_BOUNDARY_DRIFT_CHARS
    ) {
      start = paragraphStart;
    }
  }

  return { start, end };
}

export function getEarlierStreamContentRange(
  content: string,
  currentRange: StreamContentRange
): StreamContentRange | undefined {
  const end = currentRange.start;
  if (end <= 0) {
    return undefined;
  }

  let start = Math.max(0, end - STREAM_CONTENT_PAGE_CHARS);
  if (start > 0) {
    const paragraphBreak = content.indexOf("\n\n", start);
    const paragraphStart = paragraphBreak + 2;
    if (
      paragraphBreak >= 0 &&
      paragraphStart < end &&
      paragraphStart - start <= PARAGRAPH_BOUNDARY_DRIFT_CHARS
    ) {
      start = paragraphStart;
    }
  }

  return { start, end };
}
