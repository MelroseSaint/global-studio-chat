import { useQuery } from "convex/react";
import { AtSign, Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import { UserAvatar } from "@/components/UserAvatar";

/**
 * "Tag people" picker: search members and insert an @username mention into
 * the post (or share caption). The mention links in the rendered post and
 * drives the server-side tag resolution + mention notification, so tagging
 * works identically on original posts and shares.
 */
export function MentionPicker({
  onPick,
  disabled = false,
}: {
  onPick: (username: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Debounce the query so keystrokes don't fire a Convex query per key.
  const [debounced, setDebounced] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Close on outside click / touch.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  const results = useQuery(api.users.searchUsers, { query: debounced });

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary disabled:opacity-50"
        title="Tag people in this post"
      >
        <AtSign className="size-3.5" />
        Tag
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-72 max-w-[min(18rem,calc(100vw-3rem))] rounded-xl border bg-background p-2 shadow-lg">
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search people…"
              className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="mt-2 max-h-56 overflow-y-auto">
            {query.trim().length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                Search for someone to tag — they&apos;ll be notified and
                linked with an @mention.
              </p>
            ) : results === undefined ? (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Searching…
              </div>
            ) : results.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                No members found.
              </p>
            ) : (
              results.map((u) => (
                <button
                  key={u._id}
                  type="button"
                  onClick={() => {
                    onPick(u.username ?? "");
                    setOpen(false);
                    setQuery("");
                    setDebounced("");
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                >
                  <UserAvatar user={u} className="size-7" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {u.name ?? u.username ?? "Unknown"}
                    </span>
                    {u.username ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        @{u.username}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
