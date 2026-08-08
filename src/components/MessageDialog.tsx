import { useMutation, useQuery } from "convex/react";
import {
  ChevronLeft,
  Loader2,
  Lock,
  MessageSquare,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { scanWithBlocklist } from "@/convex/phishing";
import { solveChallenge } from "@/lib/pow";
import { scanForRacism } from "@/lib/racism-guard";
import { UserAvatar } from "@/components/UserAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import type { PostItem } from "@/components/PostCard";
import { SharedPostEmbed } from "@/components/SharedPostEmbed";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import {
  bootstrapDeviceKeys,
  DM_CRYPTO_AVAILABLE,
  encryptText,
  getOrCreateConversationKey,
} from "@/lib/dm-crypto";

interface Conversation {
  conversationId: string;
  lastMessageAt: number;
  unread: boolean;
  peer: {
    _id: string;
    name?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
    verified?: boolean;
    dmPublicKey?: string | null;
  } | null;
}

/**
 * Popup direct-message composer — the DM equivalent of CommentDialog: no
 * redirect to /messages. Pick a conversation (existing threads or search a
 * user), optionally with a post attached to share (the composer shows the
 * live preview card), type a message, and send — all E2E-encrypted exactly
 * like the Messages page, with the same pre-encryption gates (racism +
 * phishing blocklist) and proof-of-work. The dialog owns the device-key
 * bootstrap (shared with the Messages page via a module-level promise), so
 * a session never ends up with two keypairs on one device.
 *
 * Entry points: Share dialog's "Send via message" (sharePostId) and the
 * profile page's Message button (initialUserId).
 */
export function MessageDialog({
  open,
  onOpenChange,
  sharePostId,
  initialUserId,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A post to attach to the outgoing message (rendered as a card). */
  sharePostId?: string | null;
  /** A recipient to open a conversation with immediately (Profile → Message). */
  initialUserId?: string | null;
  onSent?: () => void;
}) {
  const { user } = useAuth();
  const setDmPublicKey = useMutation(api.dms.setDmPublicKey);
  const openConversation = useMutation(api.dms.openConversation);
  const sendMessage = useMutation(api.dms.sendMessage);

  const [privateKey, setPrivateKey] = useState<string | null>(null);
  // The conversation being written to; null = still picking a recipient.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [phishConfirm, setPhishConfirm] = useState<{ reason: string } | null>(
    null,
  );
  // The derived thread key, tagged with its conversation (see Messages).
  const [keyState, setKeyState] = useState<{
    conversationId: string;
    key: CryptoKey | null;
    issue: null | "peer-no-key" | "failed";
  }>({ conversationId: "", key: null, issue: null });

  // Queries only run while the dialog is open — PostCard mounts one of
  // these per card, and a closed dialog must not fire feed-wide DM work.
  const powChallenge = useQuery(api.pow.getChallenge, open ? undefined : "skip");
  const activeBlocklist = useQuery(
    api.blocklist.getActiveBlocklist,
    open ? undefined : "skip",
  );
  const conversations = useQuery(
    api.dms.listConversations,
    open ? undefined : "skip",
  );
  const sharedPost = useQuery(
    api.posts.getPost,
    open && sharePostId
      ? { postId: sharePostId as Id<"posts"> }
      : "skip",
  );
  const searchResults = useQuery(
    api.users.searchUsers,
    open && search.trim().length >= 2 ? { query: search.trim() } : "skip",
  );

  // Fresh state on every open.
  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setDraft("");
    setSearch("");
    setPhishConfirm(null);
    setKeyState({ conversationId: "", key: null, issue: null });
  }, [open]);

  // Device-key bootstrap: same shared promise as the Messages page.
  useEffect(() => {
    if (!open || !user?._id || !DM_CRYPTO_AVAILABLE) return;
    let cancelled = false;
    void bootstrapDeviceKeys(user._id)
      .then(async ({ pub, priv }) => {
        await setDmPublicKey({ publicKey: pub }).catch(() => {
          // Best-effort: if the registration fails the thread still opens;
          // the peer just can't encrypt to us until it retries.
        });
        if (!cancelled) setPrivateKey(priv);
      })
      .catch(() => {
        // A keypair generation failure (extremely rare) just leaves the
        // dialog locked with the crypto banner shown.
      });
    return () => {
      cancelled = true;
    };
  }, [open, user?._id, setDmPublicKey]);

  // Profile → Message: resolve the ?user= target into a conversation.
  useEffect(() => {
    if (!open || !initialUserId || !user?._id || initialUserId === user._id)
      return;
    let cancelled = false;
    void openConversation({ userId: initialUserId as Id<"users"> })
      .then((result) => {
        if (!cancelled) setSelectedId(result.conversationId);
      })
      .catch((err) => {
        if (!cancelled)
          toast.error(
            err instanceof Error ? err.message : "Could not open a conversation.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [open, initialUserId, user?._id, openConversation]);

  const activeConv =
    conversations?.find((c) => c.conversationId === selectedId) ?? null;

  // Derive (or load from the device cache) the AES key for the thread.
  useEffect(() => {
    if (!activeConv || !privateKey || !selectedId) return;
    if (!activeConv.peer?.dmPublicKey) return;
    const conversationId = activeConv.conversationId;
    let cancelled = false;
    void getOrCreateConversationKey(
      conversationId,
      privateKey,
      activeConv.peer.dmPublicKey,
    )
      .then((key) => {
        if (!cancelled) setKeyState({ conversationId, key, issue: null });
      })
      .catch(() => {
        if (!cancelled) setKeyState({ conversationId, key: null, issue: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [activeConv, privateKey, selectedId]);

  const keyReady = keyState.conversationId === selectedId;
  const convKey = keyReady ? keyState.key : null;
  const keyIssue: null | "peer-no-key" | "failed" =
    activeConv !== null && !activeConv.peer?.dmPublicKey
      ? "peer-no-key"
      : keyReady
        ? keyState.issue
        : null;

  const startConversation = async (userId: string) => {
    try {
      const result = await openConversation({ userId: userId as Id<"users"> });
      setSearch("");
      setSelectedId(result.conversationId);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not open a conversation.",
      );
    }
  };

  const send = async (force = false) => {
    const text = draft.trim();
    if ((!text && !sharePostId) || !convKey || !selectedId || sending) return;
    // Pre-encryption gates, identical to the Messages page: PureWire never
    // sees plaintext, so the checks run on this device first.
    if (text) {
      const racismResult = scanForRacism(text);
      if (racismResult.status === "blocked") {
        toast.error(`That can't be sent — ${racismResult.reason}.`);
        return;
      }
      if (racismResult.status === "review") {
        toast.error(`That may not be allowed — ${racismResult.reason}. Rephrase to send.`);
        return;
      }
      const verdict = scanWithBlocklist(
        text,
        activeBlocklist?.domains ?? [],
        activeBlocklist?.patterns ?? [],
      );
      if (verdict.status === "blocked") {
        toast.error(verdict.message ?? `Not sent — ${verdict.reason}.`);
        return;
      }
      if (verdict.status === "review" && !force) {
        setPhishConfirm({ reason: verdict.reason });
        return;
      }
    }
    setPhishConfirm(null);
    setSending(true);
    try {
      let ciphertext = "";
      let iv = "";
      if (text) {
        const encrypted = await encryptText(convKey, text);
        ciphertext = encrypted.ciphertext;
        iv = encrypted.iv;
      }
      // Proof-of-work: a small local puzzle per message.
      const pow = await solveChallenge(powChallenge);
      await sendMessage({
        conversationId: selectedId as Id<"dmConversations">,
        ciphertext,
        iv,
        ...(sharePostId
          ? { sharedPostId: sharePostId as Id<"posts"> }
          : {}),
        powChallenge: pow.powChallenge,
        powNonce: pow.powNonce,
        powIssuedAt: pow.powIssuedAt,
      });
      setDraft("");
      onOpenChange(false);
      onSent?.();
      toast.success("Message sent.");
    } catch {
      toast.error("Could not send. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const peerName = (c: Conversation) =>
    c.peer?.name || c.peer?.username || "Someone";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="size-5 text-primary" />
            {selectedId === null
              ? "New message"
              : sharePostId
                ? "Share a post"
                : "New message"}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1">
            <Lock className="size-3" />
            End-to-end encrypted
          </DialogDescription>
        </DialogHeader>

        {!DM_CRYPTO_AVAILABLE ? (
          <p className="rounded-lg border border-oxide/30 bg-oxide/10 px-3 py-2.5 text-sm text-oxide dark:text-oxide-light">
            <Lock className="mr-2 inline size-4" />
            Encrypted messaging isn&apos;t available in this browser. Try a
            current version of Chrome, Edge, Firefox, or Safari.
          </p>
        ) : null}

        {selectedId === null ? (
          /* ── Recipient picker: existing threads + search ─────────── */
          <div>
            {sharePostId ? (
              <p className="mb-3 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <MessageSquare className="size-3.5 shrink-0 text-primary" />
                Sharing a post — pick a conversation (or start a new one) to
                send it.
              </p>
            ) : null}
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or @handle"
                className="w-full rounded-xl border bg-transparent py-2.5 pl-9 pr-3 text-sm outline-none ring-ring focus:ring-2"
              />
            </div>
            <div className="max-h-64 min-h-0 space-y-1 overflow-y-auto">
              {search.trim().length >= 2 ? (
                searchResults === undefined ? (
                  <div className="space-y-2 p-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 rounded-xl" />
                    ))}
                  </div>
                ) : searchResults.length === 0 ? (
                  <p className="p-4 text-center text-sm text-muted-foreground">
                    Nobody found. Double-check the name or handle.
                  </p>
                ) : (
                  searchResults.map((result) => (
                    <button
                      key={result._id}
                      type="button"
                      onClick={() => void startConversation(result._id)}
                      className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-muted/50"
                    >
                      <UserAvatar user={result} className="size-10 shrink-0" />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1 truncate text-sm font-semibold">
                          {result.name || result.username}
                          {result.verified ? (
                            <VerifiedBadge className="size-4" />
                          ) : null}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          @{result.username}
                        </span>
                      </span>
                    </button>
                  ))
                )
              ) : conversations === undefined ? (
                <div className="space-y-2 p-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-14 rounded-xl" />
                  ))}
                </div>
              ) : conversations.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  No conversations yet — search for someone above.
                </p>
              ) : (
                conversations.map((c) => (
                  <button
                    key={c.conversationId}
                    type="button"
                    onClick={() => setSelectedId(c.conversationId)}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-muted/50"
                  >
                    <UserAvatar user={c.peer} className="size-10 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="truncate text-sm font-semibold">
                          {peerName(c)}
                        </span>
                        {c.peer?.verified ? (
                          <VerifiedBadge className="size-4" />
                        ) : null}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Lock className="size-3 shrink-0" />
                        {c.unread ? "New message" : "Encrypted message"}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          /* ── Composer for the chosen conversation ────────────────── */
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="-ml-1 shrink-0 rounded-full"
                aria-label="Change recipient"
                onClick={() => setSelectedId(null)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <UserAvatar user={activeConv?.peer} className="size-8 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 truncate text-sm font-semibold">
                  {activeConv ? peerName(activeConv) : "…"}
                  {activeConv?.peer?.verified ? (
                    <VerifiedBadge className="size-4" />
                  ) : null}
                </p>
              </div>
            </div>

            {keyIssue === "peer-no-key" ? (
              <p className="mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
                <ShieldCheck className="size-4 shrink-0 text-primary" />
                They haven&apos;t opened Messages yet, so their encryption key
                isn&apos;t ready. Ask them to open Messages once — then chat
                unlocks here.
              </p>
            ) : null}
            {keyIssue === "failed" ? (
              <p className="mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs text-muted-foreground">
                <Lock className="size-4 shrink-0 text-oxide" />
                This device can&apos;t unlock this conversation.
              </p>
            ) : null}

            {phishConfirm ? (
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-oxide/30 bg-oxide/10 px-3 py-2 text-xs text-oxide dark:text-oxide-light">
                <ShieldAlert className="mr-1 inline size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  This looks like it might be a scam link —{" "}
                  {phishConfirm.reason.replace(/^Suspected phishing — /, "")}.
                  Send anyway?
                </span>
                <span className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => void send(true)}
                  >
                    Send anyway
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setPhishConfirm(null)}
                  >
                    Keep editing
                  </Button>
                </span>
              </div>
            ) : null}

            {sharePostId ? (
              <div className="mb-2 rounded-xl border bg-muted/40">
                <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <MessageSquare className="size-3.5" />
                    Sharing a post
                  </span>
                  <button
                    type="button"
                    aria-label="Remove shared post"
                    className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => {
                      setDraft("");
                      onOpenChange(false);
                    }}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                {sharedPost === undefined ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs opacity-80">
                    <Loader2 className="size-3.5 animate-spin" />
                    Loading post…
                  </div>
                ) : sharedPost === null ? (
                  <div className="px-3 py-2 text-xs italic opacity-80">
                    This post is no longer available
                  </div>
                ) : (
                  <SharedPostEmbed
                    post={sharedPost as PostItem}
                    autoPlayMedia
                  />
                )}
              </div>
            ) : null}

            <div className="flex items-end gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  convKey
                    ? "Say it anyway — encrypted…"
                    : "Waiting for the encryption key…"
                }
                rows={2}
                maxLength={2000}
                disabled={!convKey || keyIssue !== null || sending}
                className="min-h-10 max-h-32 flex-1 resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <Button
                size="icon"
                className="shrink-0 rounded-full"
                disabled={
                  (!draft.trim() && !sharePostId) || !convKey || sending
                }
                onClick={() => void send()}
                aria-label="Send"
              >
                {sending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
