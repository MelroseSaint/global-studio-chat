import { useQuery } from "convex/react";
import { Link2, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SharedPostCard } from "@/components/SharedPostCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  extractSharedPostId,
  extractSharedPostLink,
} from "@/lib/sharedPost";

/**
 * The "attach a post to a comment" control, mirroring the DM share flow:
 * a small picker where you paste a PureWire post link (live-resolved), and
 * once attached, a preview card of the shared post with a remove button —
 * exactly what the recipient will see. The parent owns the value so the
 * composer can require it alongside (or instead of) text and send it with
 * addComment.
 *
 * When `text` is provided (the composer's draft), a PureWire post link
 * pasted straight into the comment is auto-detected and offered as a card
 * ("Attach as card"), with the link stripped from the draft on attach —
 * no need to open the picker.
 */
export function SharedPostComposer({
  value,
  onChange,
  text,
  onTextChange,
}: {
  value: string | null;
  onChange: (postId: string | null) => void;
  text?: string;
  onTextChange?: (next: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState("");
  // A dismissed auto-offer stays gone until the link leaves the draft, so
  // pasting the same link again (or editing) re-offers instead of nagging.
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  // A link pasted into the comment text (nothing attached yet) — offer it.
  const pasted = useMemo(
    () => (value === null && text ? extractSharedPostLink(text) : null),
    [text, value],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing stale dismissal when the link leaves the draft
    if (pasted === null && dismissedId !== null) setDismissedId(null);
  }, [pasted, dismissedId]);
  const offer = pasted !== null && pasted.id !== dismissedId ? pasted : null;

  const parsedId = useMemo(() => {
    if (offer) return offer.id;
    return extractSharedPostId(draft);
  }, [offer, draft]);
  const resolved = useQuery(
    api.posts.getPost,
    parsedId ? { postId: parsedId as Id<"posts"> } : "skip",
  );

  // Attach: hand the id to the parent and, for a pasted-in-text link, strip
  // the raw URL from the draft so the comment reads cleanly next to the card.
  const attach = (id: string, raw?: string) => {
    onChange(id);
    if (raw && onTextChange && text !== undefined) {
      onTextChange(text.replace(raw, "").replace(/\s+/g, " ").trim());
    }
    setDismissedId(null);
    setPicking(false);
    setDraft("");
  };

  // Attached: the live preview (loading / no-longer-available / card) with
  // a remove button, like the DM composer preview.
  if (value !== null) {
    return (
      <div className="relative mt-2 rounded-xl border bg-muted/30">
        <button
          type="button"
          aria-label="Remove shared post"
          className="absolute right-1.5 top-1.5 z-10 rounded-full bg-background/80 p-1 text-muted-foreground shadow-sm transition-colors hover:bg-background hover:text-foreground"
          onClick={() => onChange(null)}
        >
          <X className="size-3.5" />
        </button>
        <SharedPostCard postId={value} />
      </div>
    );
  }

  // Auto-detected: a post link pasted into the comment text.
  if (offer) {
    return (
      <div className="mt-2 rounded-xl border bg-muted/30 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <Link2 className="size-3.5" />
            Post link detected
          </span>
          <button
            type="button"
            onClick={() => setDismissedId(offer.id)}
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
        {resolved === undefined ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs opacity-80">
            <Loader2 className="size-3.5 animate-spin" />
            Checking post…
          </div>
        ) : resolved === null ? (
          <p className="mt-1.5 text-xs italic text-muted-foreground">
            That post isn&apos;t available (deleted, blocked, or not visible
            to you).
          </p>
        ) : (
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-xs">
              <span className="font-semibold">
                {resolved.author?.name ?? resolved.author?.username ?? "Post"}
              </span>
              &nbsp;·&nbsp;
              {resolved.content
                ? resolved.content.slice(0, 40).trim()
                : "media post"}
            </span>
            <Button
              size="sm"
              className="h-7 shrink-0 px-3 text-xs"
              onClick={() => attach(offer.id, offer.raw)}
            >
              Attach as card
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (!picking) {
    return (
      <button
        type="button"
        onClick={() => setPicking(true)}
        className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-primary"
      >
        <Link2 className="size-3.5" />
        Attach a post
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-xl border bg-muted/30 p-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Paste a PureWire post link…"
          className="h-8 flex-1 text-sm"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setPicking(false);
              setDraft("");
            }
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => {
            setPicking(false);
            setDraft("");
          }}
        >
          Cancel
        </Button>
      </div>
      {parsedId === null && draft.trim() !== "" ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Paste a post link like{" "}
          <span className="font-medium">/post/&lt;id&gt;</span>.
        </p>
      ) : null}
      {parsedId !== null ? (
        resolved === undefined ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs opacity-80">
            <Loader2 className="size-3.5 animate-spin" />
            Checking post…
          </div>
        ) : resolved === null ? (
          <p className="mt-1.5 text-xs italic text-muted-foreground">
            That post isn&apos;t available (deleted, blocked, or not visible
            to you).
          </p>
        ) : (
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-xs">
              ✓{" "}
              <span className="font-semibold">
                {resolved.author?.name ?? resolved.author?.username ?? "Post"}
              </span>
              &nbsp;·&nbsp;
              {resolved.content
                ? resolved.content.slice(0, 40).trim()
                : "media post"}
            </span>
            <Button
              size="sm"
              className="h-7 shrink-0 px-3 text-xs"
              onClick={() => attach(parsedId)}
            >
              Attach
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}
