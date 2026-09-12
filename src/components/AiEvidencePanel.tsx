import { ShieldCheck } from "lucide-react";

/**
 * Structured evidence panel for the admin AI review queue (and the racism
 * review queue). Reads the aiEvidence object stored on every post that had
 * media attached — byte scan verdict, C2PA provenance, and OCR racism
 * result — so moderators see exactly which signal triggered the flag
 * instead of a generic "media flagged" message.
 */
export function AiEvidencePanel({
  post,
}: {
  post: {
    aiStatusReason?: string | null;
    aiEvidence?: {
      byteScan?: { status: string; reason?: string };
      c2pa?: { humanCapture: boolean; claimGenerator?: string } | null;
      ocrRacism?: { status: string; reason: string } | null;
    } | null;
    c2paVerifiedHuman?: boolean | null;
    c2paClaimGenerator?: string | null;
    creatorDisclosure?: string | null;
    reportCount?: number | null;
  };
}) {
  const ev = post.aiEvidence;

  return (
    <div className="mt-2 rounded-lg border bg-muted/30 p-3 text-xs">
      <div className="flex flex-col gap-2">

        {/* ── Byte scan ─────────────────────────────────── */}
        {ev?.byteScan ? (
          <div className="flex items-start justify-between gap-2">
            <span className="shrink-0 font-medium text-muted-foreground">
              Byte scan
            </span>
            <span className="flex items-center gap-1.5 text-right">
              <VerdictBadge status={ev.byteScan.status} />
              {ev.byteScan.reason ? (
                <span className="line-clamp-2 text-muted-foreground">
                  {ev.byteScan.reason}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}

        {/* ── C2PA provenance ───────────────────────────── */}
        <div className="flex items-center justify-between gap-2">
          <span className="shrink-0 font-medium text-muted-foreground">
            C2PA provenance
          </span>
          <span className="text-right">
            {post.c2paVerifiedHuman ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-copper/30 bg-copper/10 px-1.5 py-0.5 text-[11px] font-medium text-copper">
                <ShieldCheck className="size-3" />
                Camera capture
                {post.c2paClaimGenerator
                  ? ` · ${post.c2paClaimGenerator}`
                  : ""}
              </span>
            ) : ev?.c2pa ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                Present — AI asserted
              </span>
            ) : (
              <span className="text-muted-foreground">Not present</span>
            )}
          </span>
        </div>

        {/* ── OCR racism ─────────────────────────────────── */}
        {ev?.ocrRacism ? (
          <div className="flex items-start justify-between gap-2">
            <span className="shrink-0 font-medium text-muted-foreground">
              OCR racism
            </span>
            <span className="flex items-center gap-1.5 text-right">
              <VerdictBadge
                status={ev.ocrRacism.status === "blocked" ? "blocked" : "review"}
              />
              <span className="line-clamp-2 text-muted-foreground">
                {ev.ocrRacism.reason}
              </span>
            </span>
          </div>
        ) : null}

        {/* ── AI detector (text scan) ────────────────────── */}
        <div className="flex items-start justify-between gap-2">
          <span className="shrink-0 font-medium text-muted-foreground">
            AI detector
          </span>
          <span className="text-right">
            {post.aiStatusReason ? (
              <span className="text-oxide dark:text-oxide-light">
                {post.aiStatusReason}
              </span>
            ) : (
              <span className="text-muted-foreground">
                Statistical scan — no specific signal
              </span>
            )}
          </span>
        </div>

        {/* ── Creator disclosure ─────────────────────────── */}
        <div className="flex items-center justify-between gap-2">
          <span className="shrink-0 font-medium text-muted-foreground">
            Creator disclosure
          </span>
          <span>
            {post.creatorDisclosure === "ai-assisted" ? (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                AI-assisted
              </span>
            ) : (
              <span className="text-muted-foreground">Human-made</span>
            )}
          </span>
        </div>

        {/* ── User reports ───────────────────────────────── */}
        <div className="flex items-center justify-between gap-2">
          <span className="shrink-0 font-medium text-muted-foreground">
            User reports
          </span>
          <span>
            {(post.reportCount ?? 0) > 0 ? (
              <span className="font-medium">
                {post.reportCount} open
              </span>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </span>
        </div>

      </div>
    </div>
  );
}

/** Tiny colored badge: BLOCKED (red), REVIEW (amber), CLEAN (moss). */
function VerdictBadge({ status }: { status: string }) {
  const colors =
    status === "blocked"
      ? "bg-destructive/15 text-destructive"
      : status === "review"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-moss/15 text-moss";
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${colors}`}
    >
      {status.toUpperCase()}
    </span>
  );
}


