/**
 * Human phrase for the auto-close comment policy, e.g. \"after 30 days or
 * 100 comments\". Fed by the server-hydrated thresholds on each post (see
 * posts.withAuthor); the defaults only apply when a surface like the Help
 * FAQ has no post context — keep them in sync with the server constants
 * (COMMENT_AUTO_CLOSE_AGE_MS / COMMENT_AUTO_CLOSE_COUNT in posts.ts).
 */
export function autoClosePolicyPhrase(
  ageMs?: number | null,
  count?: number | null,
): string {
  const days = ageMs ? Math.max(1, Math.round(ageMs / 86_400_000)) : 30;
  const n = count ?? 100;
  return `after ${days} days or ${n} comments`;
}
