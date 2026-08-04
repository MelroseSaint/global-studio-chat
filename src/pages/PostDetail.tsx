import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  Loader2,
  MessageCircle,
  MoreHorizontal,
  ScanSearch,
  Send,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useParams } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PostCard, type PostItem } from "@/components/PostCard";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { aiReportTicketArgs } from "@/lib/ai-report";
import { phishingTicketArgs } from "@/lib/phishing-report";

/**
 * The actions on a single comment. Comments had no menu before; the one
 * action that matters for the platform's integrity is the one-tap phishing
 * report — a ticket pre-attached to the post, the commenter, and the
 * "No scams or phishing" Standard principle.
 */
function CommentMenu({
  postId,
  comment,
}: {
  postId: Id<"posts">;
  comment: {
    author: { _id: string } | null;
    content: string;
  };
}) {
  const createTicket = useMutation(api.support.createTicket);
  const [reporting, setReporting] = useState(false);
  const [reportingAi, setReportingAi] = useState(false);

  // One-tap AI-content report on a comment, mirroring the phishing quick
  // action: files a ticket pre-attached to the post, the commenter, and the
  // "No AI-generated content" principle.
  const reportAi = async () => {
    if (reportingAi) return;
    setReportingAi(true);
    try {
      await createTicket(
        aiReportTicketArgs({
          postId,
          offenderId: comment.author?._id as Id<"users"> | undefined,
          content: comment.content,
          kind: "comment",
        }),
      );
      toast.success("AI-content report sent — our team will review it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send report.");
    } finally {
      setReportingAi(false);
    }
  };

  const reportPhishing = async () => {
    if (reporting) return;
    setReporting(true);
    try {
      await createTicket(
        phishingTicketArgs({
          postId,
          offenderId: comment.author?._id as Id<"users"> | undefined,
          content: comment.content,
          kind: "comment",
        }),
      );
      toast.success("Phishing report sent — our team will review it.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send report.");
    } finally {
      setReporting(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 max-sm:opacity-100"
          aria-label="Comment actions"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void reportAi()}>
          <ScanSearch className="size-4 text-oxide" />
          Report AI content
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void reportPhishing()}>
          <ShieldAlert className="size-4 text-destructive" />
          Report phishing
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PostDetail() {
  const { postId = "" } = useParams();
  const { user } = useAuth();
  const postIdTyped = postId as Id<"posts">;
  const post = useQuery(api.posts.getPost, { postId: postIdTyped });
  const addComment = useMutation(api.posts.addComment);
  const { results, status, loadMore } = usePaginatedQuery(
    api.posts.listComments,
    { postId: postIdTyped },
    { initialNumItems: 15 },
  );
  const { ref, inView } = useInView();
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (inView && status === "CanLoadMore") {
      void loadMore(10);
    }
  }, [inView, status, loadMore]);

  if (post === undefined) {
    return (
      <div className="p-4">
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (post === null) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        This post doesn&apos;t exist.
      </p>
    );
  }

  const comments = results as unknown as {
    _id: string;
    author: {
      _id: string;
      name?: string | null;
      username?: string | null;
      avatarUrl?: string | null;
      verified?: boolean | null;
    } | null;
    content: string;
    _creationTime: number;
  }[];

  const submit = async () => {
    const text = comment.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const res = await addComment({ postId: postIdTyped, content: text });
      if (!res.ok) {
        toast.error(res.error ?? "Could not comment.");
        return;
      }
      setComment("");
      toast.success("Comment posted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not comment.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pb-20 lg:pb-0">
      <PostCard post={post as unknown as PostItem} />

      {/* Comment composer */}
      <div className="flex gap-3 border-b px-4 py-3 sm:px-5">
        <UserAvatar user={user} className="size-9" />
        <div className="flex flex-1 items-end gap-2">
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Write a comment…"
            rows={1}
            maxLength={500}
            className="min-h-10 resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <Button
            size="icon"
            className="shrink-0 rounded-full"
            disabled={!comment.trim() || submitting}
            onClick={() => void submit()}
            aria-label="Send comment"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-5 py-3 text-sm font-semibold">
        <MessageCircle className="size-4 text-muted-foreground" />
        Comments
      </div>

      {status === "LoadingFirstPage" && (
        <div className="space-y-3 p-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      )}

      {comments.length === 0 && status !== "LoadingFirstPage" && (
        <p className="px-5 pb-8 text-sm text-muted-foreground">
          No comments yet. Be the first to reply.
        </p>
      )}

      {comments.map((c) => (
        <div key={c._id} className="group flex gap-3 px-4 py-3 sm:px-5">
          <UserAvatar user={c.author} className="size-9" />
          <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm bg-muted/60 px-4 py-2.5">
            <p className="text-sm font-semibold">
              {c.author?.name || c.author?.username || "Unknown"}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {c.content}
            </p>
          </div>
          <CommentMenu postId={postIdTyped} comment={c} />
        </div>
      ))}

      <div ref={ref} className="flex justify-center py-4">
        {status === "LoadingMore" && (
          <span className="text-sm text-muted-foreground">Loading more…</span>
        )}
      </div>
    </div>
  );
}
