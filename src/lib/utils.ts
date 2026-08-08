import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Normalize an error for display. Convex masks error messages at the public
 * HTTP boundary: plain `Error`s surface as a generic "Server Error", and even
 * `ConvexError.message` is masked — the real payload crosses in `err.data`
 * (see Auth.tsx authErrorMessage). So read `err.data` first when it's a
 * non-empty string, then fall back to `err.message`, then the caller's
 * fallback copy. Mirrors the auth flow's established pattern so every toast
 * and inline error shows the actual reason instead of "Server Error".
 */
export function errorMessage(err: unknown, fallback: string): string {
  const data =
    err instanceof Error && "data" in err
      ? (err as { data?: unknown }).data
      : undefined;
  if (typeof data === "string" && data.length > 0) {
    return data;
  }
  const msg = err instanceof Error ? err.message : "";
  return msg.length > 0 && !/^\[request id:.*\]? server error/i.test(msg)
    ? msg
    : fallback;
}
