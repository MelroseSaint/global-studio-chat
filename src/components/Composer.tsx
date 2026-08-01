import { useMutation } from "convex/react";
import { Loader2, Send } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { MediaUpload, type MediaItem } from "@/components/MediaUpload";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

const MAX_LENGTH = 1000;

export function Composer({ onPosted }: { onPosted?: () => void }) {
  const { user } = useAuth();
  const createPost = useMutation(api.posts.createPost);
  const [content, setContent] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canPost = content.trim().length > 0 || media.length > 0;
  const overLimit = content.length > MAX_LENGTH;

  const submit = async () => {
    if (!canPost || submitting || overLimit) return;
    setSubmitting(true);
    try {
      await createPost({
        content: content.trim(),
        media:
          media.length > 0
            ? media.map((m) => ({
                storageId: m.storageId,
                kind: m.kind,
              }))
            : undefined,
      });
      setContent("");
      setMedia([]);
      toast.success("Posted!");
      onPosted?.();
      textareaRef.current?.focus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not post.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex gap-3 border-b px-4 py-4 sm:px-5">
      <UserAvatar user={user} className="size-11" />
      <div className="min-w-0 flex-1">
        <Textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Say it anyway…"
          rows={2}
          maxLength={MAX_LENGTH + 10}
          className="resize-none border-none bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MediaUpload
              value={media}
              onChange={setMedia}
              max={4}
              compact
            />
          </div>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "text-xs tabular-nums",
                overLimit
                  ? "font-semibold text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {content.length}/{MAX_LENGTH}
            </span>
            <Button
              size="sm"
              disabled={!canPost || submitting || overLimit}
              onClick={() => void submit()}
              className="rounded-full px-5"
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Post
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
