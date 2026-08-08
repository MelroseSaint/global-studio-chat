import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeft,
  Link2,
  Loader2,
  MessageCircle,
  MessageSquare,
  Repeat2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MentionPicker } from "@/components/MentionPicker";
import type { PostItem } from "@/components/PostCard";
import { SharedPostEmbed } from "@/components/SharedPostEmbed";
import { extractSharedPostId } from "@/components/SharedPostComposer";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { postUrl } from "@/lib/format";
import { solvePow } from "@/lib/pow";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 1000;

/**
 * Facebook-style share dialog: write an optional caption, tag people with
 * @mentions, and post the share — which renders the original post (with
 * its media) embedded beneath your caption on feeds and your profile.
 * "Copy link" is the lightweight alternative (no new post, no share count).
 */
export function ShareDialog({
  post,
  open,
  onOpenChange,
  onShared,
  onSendViaMessage,
}: {
  post: PostItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShared?: () => void;
  // When provided, "Send via message" pops up a compose dialog instead of
  // redirecting to /messages (the owner renders MessageDialog).
  onSendViaMessage?: (postId: string) => void;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const createShare = useMutation(api.posts.createShare);
  // A fresh proof-of-work challenge, cached for the session (see Composer).
  const powChallenge = useQuery(api.pow.getChallenge);
  const [caption, setCaption] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Two-step flow: "share" is the public share form, "comment" picks a
  // destination post to drop this one into as a comment link card
  // (mirroring the DM flow's pick-a-conversation step).
  const [mode, setMode] = useState<"share" | "comment">("share");
  const [destDraft, setDestDraft] = useState("");
  const destId = useMemo(() => extractSharedPostId(destDraft), [destDraft]);
  const destPost = useQuery(
    api.posts.getPost,
    destId ? { postId: destId as Id<"posts"> } : "skip",
  );
  // Recent posts as quick-pick destinations (a shallow global feed slice).
  const quickPicks = useQuery(api.posts.feed, {
    filter: "global",
    paginationOpts: { numItems: 5, cursor: null },
  });
  const quickPosts = (quickPicks?.page ?? []) as unknown as PostItem[];

  // The post that will be embedded: for a share-of-a-share the server
  // flattens to the original, so preview the same original here.
  const original = post.sharedFrom ?? post;
  const overLimit = caption.length > MAX_LENGTH;

  const insertMention = (username: string) => {
    if (!username) return;
    const ta = textareaRef.current;
    setCaption((c) => {
      const token = `@${username} `;
      if (ta) {
        const start = ta.selectionStart ?? c.length;
        const end = ta.selectionEnd ?? c.length;
        const next = c.slice(0, start) + token + c.slice(end);
        requestAnimationFrame(() => {
          ta.focus();
          const pos = start + token.length;
          ta.setSelectionRange(pos, pos);
        });
        return next;
      }
      return c + token;
    });
  };

  const submit = async () => {
    if (submitting || overLimit) return;
    if (!powChallenge) return;
    setSubmitting(true);
    try {
      // Proof-of-work before the write — same scheme as posting/commenting.
      const proof = await solvePow(
        powChallenge.challenge,
        powChallenge.difficulty,
      );
      const res = await createShare({
        postId: post._id,
        content: caption.trim(),
        powChallenge: powChallenge.challenge,
        powNonce: proof.nonce,
        powIssuedAt: proof.issuedAt,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Could not share this post.");
        return;
      }
      setCaption("");
      onOpenChange(false);
      onShared?.();
      if (res.aiReviewReason) {
        toast("Your share is being checked by a human before it goes public.", {
          description: `Why: ${res.aiReviewReason}`,
        });
      } else {
        toast.success("Shared!");
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not share this post.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(postUrl(post._id));
      toast.success("Link copied to clipboard.");
      onOpenChange(false);
    } catch {
      toast.error("Could not copy link.");
    }
  };

  // Send the post privately: the popup composer (MessageDialog) opens with
  // the post attached — no redirect. Without the popup owner (fallback),
  // the Messages page picks up ?share=<postId> as before.
  const sendViaMessage = () => {
    onOpenChange(false);
    setMode("share");
    if (onSendViaMessage) {
      onSendViaMessage(post._id);
    } else {
      navigate(`/messages?share=${post._id}`);
    }
  };

  // Drop this post into another post's comments: the destination post page
  // picks up ?share=<postId>, shows the live preview in its comment
  // composer, and the comment carries the reference as a link card.
  const shareInComment = (destPostId: string) => {
    onOpenChange(false);
    setMode("share");
    setDestDraft("");
    navigate(`/post/${destPostId}?share=${post._id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === "comment" ? (
              <MessageCircle className="size-5 text-primary" />
            ) : (
              <Repeat2 className="size-5 text-primary" />
            )}
            {mode === "comment"
              ? "Share in a comment"
              : "Share this post"}
          </DialogTitle>
          <DialogDescription>
            {mode === "comment"
              ? "Pick a post to drop this one into as a comment link card — or paste its link below."
              : "Add a thought or tag people with @ — share it publicly, or send it privately via message."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-3">
          <UserAvatar user={user} className="size-9" />
          <div className="min-w-0 flex-1">
            <Textarea
              ref={textareaRef}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder={`Say something about ${original.author?.name ?? original.author?.username ?? "this post"}…`}
              rows={3}
              maxLength={MAX_LENGTH + 10}
              className="resize-none"
            />
            <div className="mt-2 flex items-center gap-2">
              <MentionPicker disabled={submitting} onPick={insertMention} />
              <span
                className={cn(
                  "ml-auto text-xs tabular-nums",
                  overLimit
                    ? "font-semibold text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {caption.length}/{MAX_LENGTH}
              </span>
            </div>
          </div>
        </div>

        {mode === "comment" ? (
          <div className="space-y-4">
            {/* Paste-a-link destination */}
            <div>
              <Input
                value={destDraft}
                onChange={(e) => setDestDraft(e.target.value)}
                placeholder="Paste a PureWire post link…"
                className="h-9"
              />
              {destId === null && destDraft.trim() !== "" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Paste a post link like{" "}
                  <span className="font-medium">/post/&lt;id&gt;</span>.
                </p>
              ) : null}
              {destId !== null ? (
                destPost === undefined ? (
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs opacity-80">
                    <Loader2 className="size-3.5 animate-spin" />
                    Checking post…
                  </p>
                ) : destPost === null ? (
                  <p className="mt-1.5 text-xs italic text-muted-foreground">
                    That post isn&apos;t available (deleted, blocked, or not
                    visible to you).
                  </p>
                ) : (
                  <Button
                    size="sm"
                    className="mt-2 h-8"
                    onClick={() => shareInComment(destId)}
                  >
                    <MessageCircle className="size-3.5" />
                    Comment on this post
                  </Button>
                )
              ) : null}
            </div>
            {/* Recent posts as quick destinations */}
            <div>
              <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
                Recent posts
              </p>
              {quickPosts.length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading…
                </div>
              ) : (
                <div className="space-y-1">
                  {quickPosts.map((p) => (
                    <button
                      key={p._id}
                      type="button"
                      onClick={() => shareInComment(p._id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/70"
                    >
                      <UserAvatar user={p.author} className="size-6" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-semibold">
                          {p.author?.name ??
                            p.author?.username ??
                            "Unknown"}
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
              )}
            </div>
          </div>
        ) : (
          <SharedPostEmbed post={original} />
        )}

        <DialogFooter>
          {mode === "comment" ? (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => setMode("share")}
              disabled={submitting}
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={sendViaMessage}
              disabled={submitting}
            >
              <MessageSquare className="size-4" />
              Send via message
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => setMode("comment")}
            disabled={submitting}
          >
            <MessageCircle className="size-4" />
            Share in a comment
          </Button>
          <Button
            variant="outline"
            onClick={() => void copyLink()}
            disabled={submitting}
          >
            <Link2 className="size-4" />
            Copy link
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || overLimit}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Repeat2 className="size-4" />
            )}
            Share
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
