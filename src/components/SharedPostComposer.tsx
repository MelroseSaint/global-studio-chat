import { useQuery } from "convex/react";
import { Link2, Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SharedPostCard } from "@/components/SharedPostCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Extract a Convex post id from a PureWire post link — accepts a bare
 * `/post/<id>` path, a full URL, or a link with an extra fragment/query.
 * Convex ids are lowercase-alphanumeric, so the capture is constrained to
 * word characters and the leading `/post/` is required (a bare id can't be
 * told apart from random text).
 */
export function extractSharedPostId(input: string): string | null {
  const match = input.trim().match(/\/post\/([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * The "attach a post to a comment" control, mirroring the DM share flow:
 * a small picker where you paste a PureWire post link (live-resolved), and
 * once attached, a preview card of the shared post with a remove button —
 * exactly what the recipient will see. The parent owns the value so the
 * composer can require it alongside (or instead of) text and send it with
 * addComment.
 */
export function SharedPostComposer({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (postId: string | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState("");
  const parsedId = useMemo(() => extractSharedPostId(draft), [draft]);
  const resolved = useQuery(
    api.posts.getPost,
    parsedId ? { postId: parsedId as Id<"posts"> } : "skip",
  );

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
              onClick={() => {
                onChange(parsedId);
                setPicking(false);
                setDraft("");
              }}
            >
              Attach
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}
