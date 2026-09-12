import { useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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

const MAX_POST_CHARS = 1000;

/**
 * Edit a post's text body (media is not editable here — it would mean
 * re-running the full media pipeline, so the composer only lets the author
 * revise the caption). The server re-scans the replacement text through
 * the same AI/blocklist/adult/racism gates as creation, so an edit is
 * never a way to smuggle content past them.
 */
export function EditPostDialog({
  postId,
  initialContent,
  open,
  onOpenChange,
}: {
  postId: Id<"posts">;
  initialContent: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const editPost = useMutation(api.posts.editPost);
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    const text = content.trim();
    if (text.length === 0) {
      toast.error("Post must contain text or media.");
      return;
    }
    if (text.length > MAX_POST_CHARS) {
      toast.error(`Post is too long (max ${MAX_POST_CHARS} characters).`);
      return;
    }
    setSaving(true);
    try {
      const res = await editPost({ postId, content: text });
      if (res && res.ok === false) {
        toast.error(res.error);
        return;
      }
      toast.success("Post updated.");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the post.");
    } finally {
      setSaving(false);
    }
  };

  // The content is gated on `open` so the composer state mounts fresh
  // each time the dialog opens (Radix unmounts it on close) — a reopened
  // dialog always shows the post's current text, never a stale draft.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit post</DialogTitle>
          <DialogDescription>
            Only the text changes — media and disclosure stay as posted.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          maxLength={MAX_POST_CHARS}
          placeholder="What's on your mind?"
          autoFocus
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Edits are re-scanned with the same rules as new posts.</span>
          <span className="tabular-nums">
            {content.length}/{MAX_POST_CHARS}
          </span>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
      ) : null}
    </Dialog>
  );
}
