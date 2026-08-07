import { useMutation, useQuery } from "convex/react";
import { Link2, Loader2, Repeat2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { MentionPicker } from "@/components/MentionPicker";
import type { PostItem } from "@/components/PostCard";
import { SharedPostEmbed } from "@/components/SharedPostEmbed";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
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
}: {
  post: PostItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShared?: () => void;
}) {
  const { user } = useAuth();
  const createShare = useMutation(api.posts.createShare);
  // A fresh proof-of-work challenge, cached for the session (see Composer).
  const powChallenge = useQuery(api.pow.getChallenge);
  const [caption, setCaption] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat2 className="size-5 text-primary" />
            Share this post
          </DialogTitle>
          <DialogDescription>
            Add a thought or tag people with @ — or share it as-is.
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

        <SharedPostEmbed post={original} />

        <DialogFooter>
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
