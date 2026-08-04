import type { Id } from "@/convex/_generated/dataModel";

/**
 * The one-tap "Report phishing" ticket.
 *
 * Used by the post and comment menus: a member who spots a suspected scam
 * files a complete ticket with a single click — no form, no explaining the
 * situation. The ticket is pre-attached to the offending post, the offender
 * account, and the "No scams or phishing" Standard principle, so the admin
 * queue shows exactly what was flagged and under which rule.
 */
export function phishingTicketArgs(params: {
  postId: Id<"posts">;
  offenderId?: Id<"users"> | null;
  content: string;
  kind: "post" | "comment";
}) {
  return {
    // Matches the ReportDialog subject shape ("Report: <principle title>").
    subject: "Report: No scams or phishing.",
    message: `Reported as suspected phishing in a ${params.kind}: “${params.content.slice(0, 200)}”`,
    postId: params.postId,
    offenderId: params.offenderId ?? undefined,
    violation: "No scams or phishing.",
    standardId: "no-scams",
  };
}
