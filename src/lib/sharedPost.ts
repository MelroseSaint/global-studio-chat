/**
 * Shared-post link extraction utilities used by both the DM/comment
 * composer and the Share dialog. Extracted from SharedPostComposer.tsx
 * so the component can be fast-refreshed without warnings.
 */

/**
 * Extract a PureWire post link from arbitrary text. Accepts a bare
 * `/post/<id>` path or a full `https://…/post/<id>` URL, and returns the
 * id plus the raw matched span so the caller can strip the link out of a
 * draft. Convex ids are lowercase-alphanumeric, so the capture is
 * constrained to word characters and the leading `/post/` is required (a
 * bare id can't be told apart from random text).
 */
export function extractSharedPostLink(
  input: string,
): { id: string; raw: string } | null {
  const match = input.match(
    /https?:\/\/[^\s/]+\/post\/([A-Za-z0-9]+)|\/post\/([A-Za-z0-9]+)/,
  );
  if (!match) return null;
  return { id: match[1] ?? match[2], raw: match[0] };
}

export function extractSharedPostId(input: string): string | null {
  return extractSharedPostLink(input)?.id ?? null;
}
