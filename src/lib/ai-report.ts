import type { Id } from "@/convex/_generated/dataModel";

/**
 * The one-tap "Report AI content" ticket.
 *
 * Used by the post and comment menus: a member who spots content they
 * believe is machine-made files a complete ticket with a single click — no
 * form, no explaining the situation. The ticket is pre-attached to the
 * offending post, the offender account, and the "No AI-generated content"
 * Standard principle, so the admin queue shows exactly what was flagged and
 * under which rule. PureWire's own scanners catch most AI content before it
 * goes live; this is the human net on top, so members can flag what the
 * automated layer missed.
 */
export function aiReportTicketArgs(params: {
  postId: Id<"posts">;
  offenderId?: Id<"users"> | null;
  content: string;
  kind: "post" | "comment";
}) {
  // A short excerpt of the flagged content helps the admin judge at a
  // glance; media-only posts have no text, so the message stays clean.
  const trimmed = params.content.trim();
  const excerpt =
    trimmed.length > 180 ? `${trimmed.slice(0, 180)}…` : trimmed;
  return {
    // Matches the ReportDialog subject shape ("Report: <principle title>").
    subject: "Report: No AI-generated content.",
    message: `Reported as suspected AI-generated content in a ${params.kind}${
      excerpt.length > 0 ? `: “${excerpt}”` : ""
    }`,
    postId: params.postId,
    offenderId: params.offenderId ?? undefined,
    violation: "No AI-generated content.",
    standardId: "no-ai-content",
  };
}
