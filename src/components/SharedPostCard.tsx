import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { PostItem } from "@/components/PostCard";
import { SharedPostEmbed } from "@/components/SharedPostEmbed";

/**
 * A post referenced by id, rendered as a preview card. Lives in its own
 * component because useQuery can't run inside a message/comment map loop.
 * The post is fetched through the normal visibility rules
 * (api.posts.getPost), so a deleted, blocked, or silenced post degrades to
 * "no longer available" for the viewer — never a broken link. Video media
 * autoplays muted with controls, like the composer previews.
 *
 * Used by DM threads (Messages.tsx) and comments (post page, popup, and
 * replies) so a shared post renders identically everywhere.
 */
export function SharedPostCard({ postId }: { postId: string }) {
  const post = useQuery(api.posts.getPost, {
    postId: postId as Id<"posts">,
  });
  if (post === undefined) {
    return (
      <div className="mt-1.5 flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-xs opacity-80">
        <Loader2 className="size-3.5 animate-spin" />
        Loading post…
      </div>
    );
  }
  if (post === null) {
    return (
      <div className="mt-1.5 rounded-xl border bg-muted/40 px-3 py-2 text-xs italic opacity-80">
        This post is no longer available
      </div>
    );
  }
  return (
    <div className="mt-1.5">
      <SharedPostEmbed post={post as PostItem} autoPlayMedia />
    </div>
  );
}
