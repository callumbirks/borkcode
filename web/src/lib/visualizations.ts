/**
 * Each change of `updatedAt` gives a new URL, so frames showing a replaced page reload it. The
 * trailing slash makes relative URLs in a page shown from a file load the files beside it.
 */
export function visualizationUrl(threadId: string, id: string, updatedAt: number): string {
  return `/api/threads/${encodeURIComponent(threadId)}/visualizations/${encodeURIComponent(id)}/?v=${updatedAt}`;
}

/** Inline frames start here, and grow or shrink to fit within these bounds. */
export const FRAME_HEIGHT = { initial: 420, min: 120, max: 800 };

/**
 * The height a page reported with `postMessage({ borkcodeHeight })`, clamped, or null if the
 * message is anything else. The page is untrusted, so only a finite number gets through.
 */
export function reportedHeight(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const height = (data as { borkcodeHeight?: unknown }).borkcodeHeight;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return Math.min(Math.max(Math.ceil(height), FRAME_HEIGHT.min), FRAME_HEIGHT.max);
}
