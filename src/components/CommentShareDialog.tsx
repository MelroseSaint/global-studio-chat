import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  AudioLines,
  ChevronDown,
  Loader2,
  MessageCircle,
  MessageSquare,
  Repeat2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MessageDialog } from "@/components/MessageDialog";
import { SharedCommentEmbed } from "@/components/SharedCommentEmbed";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/UserAvatar";
import { extractSharedPostId } from "@/lib/sharedPost";
import { timeAgo } from "@/lib/format";
import { solvePow } from "@/lib/pow";
import { cn } from "@/lib/utils";

/**
 * Comment-share dialog — the comment mirror of ShareDialog. Any comment,
 * no matter its kind (text, voice note, reply), can be shared to another
 * post's comments or sent directly into a DM conversation.
 *
 * The flow picks WHICH comment from the sharer's most recent comments
 * (paginated, newest first), then WHERE: drop it into another post's
 * comment section as a card (addComment carries the reference) or send it
 * via message (MessageDialog carries it into the encrypted thread). The
 * original comment renders as a card on the receiving side through the
 * normal visibility rules.
 */
export function CommentShareDialog({
  open,
  onOpenChange,
  presetCommentId,
  onShared,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When opened from a comment's Share button, that comment is preselected. */
  presetCommentId?: string | null;
  onShared?: () => void;
}) {
  const addComment = useMutation(api.posts.addComment);
  const powChallenge = useQuery(api.pow.getChallenge);
  const [selectedId, setSelectedId] = useState<string | null>(
    presetCommentId ?? null,
  );
  const [showPicker, setShowPicker] = useState(presetCommentId == null);
  const [submitting, setSubmitting] = useState(false);
  const [dmOpen, setDmOpen] = useState(false);
  // Destination post (for "share into a post's comments"): paste a link or
  // quick-pick from recent posts.
  const [destDraft, setDestDraft] = useState("");
  const destId = useMemo(() => extractSharedPostId(destDraft), [destDraft]);
  const destPost = useQuery(
    api.posts.getPost,
    destId ? { postId: destId as Id<"posts"> } : "skip",
  );
  const quickPicks = useQuery(api.posts.feed, {
    filter: "global",
    paginationOpts: { numItems: 5, cursor: null },
  });
  const quickPosts = (quickPicks?.page ?? []) as unknown as {
    _id: string;
    content?: string;
    author?: { name?: string | null; username?: string | null } | null;
  }[];

  // The picker: the sharer's most recent comments, newest first.
  const recent = usePaginatedQuery(api.posts.listMyRecentComments, {}, { initialNumItems: 10 });

  // Keep the preset in sync when the dialog opens with a fresh target
  // (each comment's Share button sets a new preset; the dialog content
  // unmounts between opens so this only fires on a genuinely new target).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- preset sync on a fresh target is a well-specified pattern */
    if (presetCommentId != null) {
      setSelectedId(presetCommentId);
      setShowPicker(false);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [presetCommentId]);

  const shareIntoPost = async () => {
    if (selectedId === null || destId === null || submitting) return;
    if (!powChallenge) return;
    setSubmitting(true);
    try {
      const proof = await solvePow(
        powChallenge.challenge,
        powChallenge.difficulty,
      );
      const res = await addComment({
        postId: destId as Id<"posts">,
        content: "",
        sharedCommentId: selectedId as Id<"comments">,
        powChallenge: powChallenge.challenge,
        powNonce: proof.nonce,
        powIssuedAt: proof.issuedAt,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not share this comment.");
        return;
      }
      setDestDraft("");
      onOpenChange(false);
      onShared?.();
      toast.success("Comment shared into that post's comments.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not share this comment.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const sendViaMessage = () => {
    if (selectedId === null) return;
    onOpenChange(false);
    setDmOpen(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Repeat2 className="size-5 text-primary" />
              Share a comment
            </DialogTitle>
            <DialogDescription>
              Pick one of your recent comments, then share it into another
              post&apos;s comments or send it privately via message.
            </DialogDescription>
          </DialogHeader>

          {/* The comment being shared */}
          {selectedId !== null ? (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Sharing
                </p>
                <button
                  type="button"
                  onClick={() => setShowPicker((v) => !v)}
                  className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  {showPicker ? "Hide" : "Choose a different comment"}
                  <ChevronDown
                    className={cn(
                      "size-3.5 transition-transform",
                      showPicker && "rotate-180",
                    )}
                  />
                </button>
              </div>
              <SharedCommentEmbed commentId={selectedId} />
            </div>
          ) : null}

          {/* Recent-comments picker */}
          {showPicker || selectedId === null ? (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border bg-muted/20 p-1.5">
              {recent.results.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {recent.isLoading
                    ? "Loading your recent comments…"
                    : "No comments yet — comment on a post first, then you can share them."}
                </p>
              ) : (
                recent.results.map((c) => (
                  <button
                    key={c._id}
                    type="button"
                    onClick={() => {
                      setSelectedId(c._id);
                      setShowPicker(false);
                    }}
                    aria-pressed={c._id === selectedId}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
                      c._id === selectedId
                        ? "bg-primary/10 ring-1 ring-primary/30"
                        : "hover:bg-muted/70",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {c.content
                          ? c.content.slice(0, 60)
                          : c.hasMedia
                            ? "Voice note"
                            : "Shared content"}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {timeAgo(c._creationTime)}
                        {c.isReply ? " · reply" : ""}
                        {c.hasMedia ? " · voice note" : ""}
                        {c.hasSharedPost ? " · shared post" : ""}
                      </span>
                    </span>
                    {c.hasMedia ? (
                      <AudioLines className="size-4 shrink-0 text-primary" />
                    ) : null}
                  </button>
                ))
              )}
              {recent.status === "CanLoadMore" ? (
                <button
                  type="button"
                  onClick={() => void recent.loadMore(10)}
                  className="w-full rounded-lg px-2 py-1.5 text-center text-xs font-medium text-primary hover:bg-muted/70"
                >
                  Load more
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Destinations */}
          {selectedId !== null ? (
            <div className="space-y-4 border-t pt-4">
              <div>
                <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
                  Share into another post&apos;s comments
                </p>
                <div className="flex flex-col gap-2">
                  <Input
                    value={destDraft}
                    onChange={(e) => setDestDraft(e.target.value)}
                    placeholder="Paste a PureWire post link…"
                    className="h-9"
                  />
                  {destId === null && destDraft.trim() !== "" ? (
                    <p className="text-xs text-muted-foreground">
                      Paste a post link like{" "}
                      <span className="font-medium">/post/&lt;id&gt;</span>.
                    </p>
                  ) : null}
                  {destId !== null ? (
                    destPost === undefined ? (
                      <p className="flex items-center gap-1.5 text-xs opacity-80">
                        <Loader2 className="size-3.5 animate-spin" />
                        Checking post…
                      </p>
                    ) : destPost === null ? (
                      <p className="text-xs italic text-muted-foreground">
                        That post isn&apos;t available (deleted, blocked, or
                        not visible to you).
                      </p>
                    ) : (
                      <Button
                        size="sm"
                        className="h-8 self-start"
                        onClick={() => void shareIntoPost()}
                        disabled={submitting}
                      >
                        {submitting ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <MessageCircle className="size-3.5" />
                        )}
                        Share into this post&apos;s comments
                      </Button>
                    )
                  ) : null}
                </div>
                {quickPosts.length > 0 ? (
                  <div className="mt-2">
                    <p className="mb-1 text-xs font-semibold text-muted-foreground">
                      Recent posts
                    </p>
                    <div className="space-y-1">
                      {quickPosts.map((p) => (
                        <button
                          key={p._id}
                          type="button"
                          onClick={() => setDestDraft(`/post/${p._id}`)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/70"
                        >
                          <UserAvatar
                            user={p.author as never}
                            className="size-6"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            <span className="font-semibold">
                              {p.author?.name ?? p.author?.username ?? "Unknown"}
                            </span>
                            <span className="text-muted-foreground">
                              {" "}
                              ·{" "}
                              {p.content
                                ? p.content.slice(0, 36).trim()
                                : "media post"}
                            </span>
                          </span>
                          <MessageCircle className="size-3.5 shrink-0 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={sendViaMessage}
              disabled={selectedId === null}
            >
              <MessageSquare className="size-4" />
              Send via message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The DM composer opens with the comment attached — no redirect. */}
      <MessageDialog
        open={dmOpen}
        onOpenChange={setDmOpen}
        shareCommentId={selectedId}
      />
    </>
  );
}
