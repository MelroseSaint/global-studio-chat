import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  AudioLines,
  ChevronLeft,
  Film,
  Loader2,
  Lock,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { UserAvatar } from "@/components/UserAvatar";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import {
  decryptBytes,
  decryptText,
  encryptBytes,
  encryptText,
  generateDmKeyPair,
  getDevicePrivateKey,
  getDevicePublicKey,
  getOrCreateConversationKey,
  setDeviceKeypair,
} from "@/lib/dm-crypto";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * PureWire's end-to-end-encrypted direct messages.
 *
 * The thread you see here is decrypted in THIS browser from ciphertext that
 * PureWire's servers never understand: the server stores only encrypted
 * blobs plus who/when metadata. Keys live on the devices of the two people
 * talking, never on the platform — so there is nothing anyone (including
 * the platform) can pull out of a conversation.
 */

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

interface MessageRow {
  _id: string;
  _creationTime: number;
  senderId: string;
  ciphertext: string;
  iv: string;
  media?: {
    url: string | null;
    iv: string;
    mime: string | null;
    kind: "image" | "video" | "audio";
  };
}

type MediaKind = "image" | "video" | "audio";

function kindFromMime(type: string): MediaKind {
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "image";
}

/**
 * One shared bootstrap per page load: StrictMode mounts the effect twice,
 * and both mounts must end up with the SAME device keypair, or the stored
 * public key could disagree with the private key. A module-level promise
 * serializes the two runs so only one pair is ever generated.
 */
// WebCrypto is what powers all of this; a sandboxed frame without it gets a
// clear notice instead of a silent dead page.
const CRYPTO_AVAILABLE =
  typeof globalThis.crypto !== "undefined" &&
  typeof globalThis.crypto.subtle !== "undefined";

let keyBootstrap: Promise<{ pub: string; priv: string }> | null = null;

async function bootstrapDeviceKeys(
  userId: string,
): Promise<{ pub: string; priv: string }> {
  if (keyBootstrap === null) {
    keyBootstrap = (async () => {
      let pub = getDevicePublicKey(userId);
      let priv = getDevicePrivateKey(userId);
      if (!pub || !priv) {
        const pair = await generateDmKeyPair();
        pub = pair.publicJwk;
        priv = pair.privateJwk;
        setDeviceKeypair(userId, pair);
      }
      return { pub, priv };
    })();
  }
  return keyBootstrap;
}

export function Messages() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const convoParam = searchParams.get("convo");
  const userParam = searchParams.get("user");

  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(convoParam);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pendingMedia, setPendingMedia] = useState<{
    bytes: Uint8Array<ArrayBuffer>;
    mime: string;
    kind: MediaKind;
  } | null>(null);
  const [decrypted, setDecrypted] = useState<Record<string, string>>({});
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});

  const setDmPublicKey = useMutation(api.dms.setDmPublicKey);
  const openConversation = useMutation(api.dms.openConversation);
  const sendMessage = useMutation(api.dms.sendMessage);
  const markConversationRead = useMutation(api.dms.markConversationRead);
  const deleteConversation = useMutation(api.dms.deleteConversation);
  const discardUploads = useMutation(api.media.discardUploads);
  const prepareUpload = useAction(api.media.prepareUpload);

  const conversations = useQuery(api.dms.listConversations);
  const searchResults = useQuery(
    api.users.searchUsers,
    search.trim().length >= 2 ? { query: search.trim() } : "skip",
  );

  // Device key bootstrap: ensure this account has an ECDH keypair on THIS
  // device, and that the public half is registered so others can encrypt to
  // us. The private half never leaves the browser.
  useEffect(() => {
    if (!user?._id || !CRYPTO_AVAILABLE) return;
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
        // thread locked with the crypto banner already shown.
      });
    return () => {
      cancelled = true;
    };
  }, [user?._id, setDmPublicKey]);

  const activeConv = conversations?.find(
    (c) => c.conversationId === activeId,
  ) ?? null;

  // Derive (or load from the device cache) the AES key for the open thread.
  // The result is tagged with the conversation it belongs to, so switching
  // threads can never leak the previous thread's key into the new one — the
  // key is only in play once keyState.conversationId matches the open id.
  const [keyState, setKeyState] = useState<{
    conversationId: string;
    key: CryptoKey | null;
    issue: null | "peer-no-key" | "failed";
  }>({ conversationId: "", key: null, issue: null });
  useEffect(() => {
    if (!activeConv || !privateKey) return;
    if (!activeConv.peer?.dmPublicKey) {
      // The peer's key not existing yet is derived from the data at render
      // (keyIssue below) — no state needed for it.
      return;
    }
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
  }, [activeConv, privateKey]);

  const keyReady = keyState.conversationId === activeId;
  const convKey = keyReady ? keyState.key : null;
  const keyIssue: null | "peer-no-key" | "failed" =
    activeConv !== null && !activeConv.peer?.dmPublicKey
      ? "peer-no-key"
      : keyReady
        ? keyState.issue
        : null;

  const { results, status, loadMore } = usePaginatedQuery(
    api.dms.listMessages,
    activeId ? { conversationId: activeId as Id<"dmConversations"> } : "skip",
    { initialNumItems: 30 },
  );
  // The server pages newest-first so the initial page is the live end of
  // the thread; reversing the concatenated pages restores chronological
  // order (oldest at the top, newest at the bottom), and loadMore pulls
  // progressively older pages into the top.
  const messages = useMemo(
    () => [...((results ?? []) as unknown as MessageRow[])].reverse(),
    [results],
  );

  // Mark the thread read the moment it opens (and every time it reopens).
  useEffect(() => {
    if (activeId) {
      void markConversationRead({
        conversationId: activeId as Id<"dmConversations">,
      });
    }
  }, [activeId, markConversationRead]);

  // Decrypt messages (and fetch + decrypt any attachments) in place. Each
  // message is processed exactly once (tracked in a ref), and state updates
  // are functional, so a re-run from new messages never re-decrypts old
  // ones and never cancels an in-flight media fetch mid-batch.
  const processedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!convKey) return;
    const pending = messages.filter((m) => !processedRef.current.has(m._id));
    void (async () => {
      for (const message of pending) {
        if (processedRef.current.has(message._id)) continue;
        try {
          const text = message.ciphertext
            ? await decryptText(convKey, message.ciphertext, message.iv)
            : "";
          processedRef.current.add(message._id);
          setDecrypted((prev) => ({ ...prev, [message._id]: text }));
          if (message.media?.url) {
            const res = await fetch(message.media.url);
            if (!res.ok) continue;
            const bytes = await res.arrayBuffer();
            const plain = await decryptBytes(convKey, bytes, message.media.iv);
            const url = URL.createObjectURL(
              new Blob([plain as BlobPart], {
                type: message.media.mime ?? undefined,
              }),
            );
            setMediaUrls((prev) => ({ ...prev, [message._id]: url }));
          }
        } catch {
          processedRef.current.add(message._id);
          // Undecryptable — wrong device key, tampered data, or a message
          // whose sender key this device never had.
          setDecrypted((prev) => ({ ...prev, [message._id]: "" }));
        }
      }
    })();
    // decrypted/mediaUrls are intentionally not deps: processing is tracked
    // by processedRef and updates are functional, so including them would
    // only re-run (and re-filter) the batch on every decrypted change.
  }, [convKey, messages]);

  // Release object URLs when the page unmounts.
  useEffect(
    () => () => {
      for (const url of Object.values(mediaUrls)) {
        URL.revokeObjectURL(url);
      }
    },
    // Unmount-only cleanup — the URLs at unmount time are the ones to free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Auto-scroll to the newest message when a thread opens or a new message
  // lands — not when older pages load in at the top.
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const newestId = messages.length > 0 ? messages[messages.length - 1]._id : null;
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [newestId, activeId]);

  const openThread = (conversationId: string) => {
    setActiveId(conversationId);
    navigate(`/messages?convo=${conversationId}`, { replace: true });
  };

  const closeThread = () => {
    setActiveId(null);
    setConfirmDelete(false);
    navigate("/messages", { replace: true });
  };

  // A ?user=<id> deep link (Profile's Message button, DM notifications)
  // resolves into a conversation and opens it. Idempotent — openConversation
  // finds the existing thread if there is one. Navigation is inlined so the
  // effect has no local function dependency that changes every render.
  useEffect(() => {
    if (!userParam || !user?._id || userParam === user._id) return;
    let cancelled = false;
    void openConversation({ userId: userParam as Id<"users"> })
      .then((result) => {
        if (cancelled) return;
        setActiveId(result.conversationId);
        navigate(`/messages?convo=${result.conversationId}`, { replace: true });
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(
          err instanceof Error ? err.message : "Could not open a conversation.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [userParam, user?._id, openConversation, navigate]);

  const startConversation = async (userId: string) => {
    try {
      const result = await openConversation({ userId: userId as Id<"users"> });
      setNewOpen(false);
      setSearch("");
      openThread(result.conversationId);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not open a conversation.",
      );
    }
  };

  const pickFile = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) {
      toast.error("Keep attachments under 25 MB.");
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    setPendingMedia({
      bytes,
      mime: file.type || "application/octet-stream",
      kind: kindFromMime(file.type),
    });
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !pendingMedia) || !convKey || !activeId || sending) return;
    setSending(true);
    let uploaded: { storageId?: Id<"_storage">; key?: string } | undefined;
    try {
      let media: {
        storageId?: Id<"_storage">;
        url?: string;
        key?: string;
        iv: string;
        mime?: string;
        kind: MediaKind;
      } | undefined;
      if (pendingMedia) {
        // Encrypt the bytes FIRST — only ciphertext ever reaches storage.
        const enc = await encryptBytes(convKey, pendingMedia.bytes);
        const ticket = await prepareUpload({
          contentType: pendingMedia.mime || "application/octet-stream",
        });
        let storageId: Id<"_storage"> | undefined;
        let url: string | undefined;
        let key: string | undefined;
        if (ticket.mode === "cloudinary") {
          const form = new FormData();
          form.append(
            "file",
            new Blob([enc.data as BlobPart], {
              type: "application/octet-stream",
            }),
            "dm.enc",
          );
          form.append("upload_preset", ticket.uploadPreset);
          const res = await fetch(ticket.uploadUrl, { method: "POST", body: form });
          if (res.ok) {
            const parsed = (await res.json()) as {
              secure_url?: string;
              public_id?: string;
            };
            url = parsed.secure_url;
            key = parsed.public_id;
          }
          if (!url || !key) {
            // Resilience, same as the post composer: a Cloudinary failure
            // falls back to Convex storage rather than failing the message.
            const fallback = await fetch(ticket.fallbackUrl, {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: new Blob([enc.data], { type: "application/octet-stream" }),
            });
            if (!fallback.ok) throw new Error("Upload failed");
            const json = (await fallback.json()) as { storageId: string };
            storageId = json.storageId as Id<"_storage">;
          }
        } else {
          const res = await fetch(ticket.uploadUrl, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: new Blob([enc.data], { type: "application/octet-stream" }),
          });
          if (!res.ok) throw new Error("Upload failed");
          const json = (await res.json()) as { storageId: string };
          storageId = json.storageId as Id<"_storage">;
        }
        uploaded = { storageId, key };
        media = {
          ...(storageId !== undefined ? { storageId } : {}),
          ...(url !== undefined && key !== undefined ? { url, key } : {}),
          iv: enc.ivB64,
          mime: pendingMedia.mime,
          kind: pendingMedia.kind,
        };
      }
      let ciphertext = "";
      let iv = "";
      if (text) {
        const encrypted = await encryptText(convKey, text);
        ciphertext = encrypted.ciphertext;
        iv = encrypted.iv;
      } else if (media) {
        iv = media.iv;
      }
      await sendMessage({
        conversationId: activeId as Id<"dmConversations">,
        ciphertext,
        iv,
        ...(media !== undefined ? { media } : {}),
      });
      setDraft("");
      setPendingMedia(null);
    } catch {
      // The attachment made it to storage but the message didn't — release
      // the orphaned file (best-effort), then tell the user.
      if (uploaded?.key) {
        void discardUploads({ items: [{ key: uploaded.key }] }).catch(() => {});
      } else if (uploaded?.storageId) {
        void discardUploads({ items: [{ storageId: uploaded.storageId }] }).catch(
          () => {},
        );
      }
      toast.error("Could not send. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const handleDelete = async () => {
    if (!activeId) return;
    try {
      await deleteConversation({
        conversationId: activeId as Id<"dmConversations">,
      });
      toast.success(
        "Conversation deleted. Because PureWire never holds the keys, no copy exists anywhere.",
      );
      closeThread();
    } catch {
      toast.error("Could not delete the conversation.");
    }
  };

  const peerName = (c: Conversation) =>
    c.peer?.name || c.peer?.username || "Someone";

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col pb-16 sm:pb-0 lg:h-dvh">
      {!CRYPTO_AVAILABLE ? (
        <div className="border-b border-oxide/30 bg-oxide/10 px-4 py-3 text-sm text-oxide dark:text-oxide-light">
          <Lock className="mr-2 inline size-4" />
          Encrypted messaging isn&apos;t available in this browser. Try a
          current version of Chrome, Edge, Firefox, or Safari.
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Inbox pane */}
        <div
          className={cn(
            "w-full flex-col border-r lg:flex lg:w-80",
            activeId ? "hidden lg:flex" : "flex",
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <div>
              <h1 className="text-lg font-bold tracking-tight">Messages</h1>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Lock className="size-3" />
                End-to-end encrypted
              </p>
            </div>
            <Button
              variant="outline"
              size="icon"
              className="shrink-0"
              aria-label="New message"
              onClick={() => setNewOpen(true)}
            >
              <Plus className="size-4" />
            </Button>
          </div>

          {conversations === undefined ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="p-6">
              <Empty
                icon={MessageSquare}
                title="No conversations yet"
                description="Message someone from their profile, or start a new one here."
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {conversations.map((c) => (
                <button
                  key={c.conversationId}
                  type="button"
                  onClick={() => openThread(c.conversationId)}
                  className={cn(
                    "flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/40",
                    activeId === c.conversationId && "bg-muted/60",
                  )}
                >
                  <UserAvatar user={c.peer} className="size-11 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="truncate text-sm font-semibold">
                        {peerName(c)}
                      </span>
                      {c.peer?.verified ? <VerifiedBadge className="size-4" /> : null}
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {timeAgo(c.lastMessageAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Lock className="size-3 shrink-0" />
                      <span className="truncate">
                        {c.unread ? "New message" : "Encrypted message"}
                      </span>
                      {c.unread ? (
                        <span className="ml-auto size-2 shrink-0 rounded-full bg-primary" />
                      ) : null}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Thread pane */}
        <div
          className={cn(
            "min-w-0 flex-1 flex-col",
            activeId ? "flex" : "hidden lg:flex",
          )}
        >
          {activeConv === null ? (
            <div className="flex flex-1 items-center justify-center p-8">
              {activeId && conversations !== undefined ? (
                <div className="flex flex-col items-center gap-3 text-center">
                  <p className="text-sm text-muted-foreground">
                    This conversation was deleted for everyone. No copy exists
                    anywhere.
                  </p>
                  <Button variant="outline" size="sm" onClick={closeThread}>
                    Back to messages
                  </Button>
                </div>
              ) : (
                <Empty
                  icon={Lock}
                  title="Pick a conversation"
                  description="Every message here is encrypted in your browser before it leaves your device — and decrypted only by the person you're talking to."
                />
              )}
            </div>
          ) : (
            <>
              {/* Thread header */}
              <div className="flex items-center gap-2 border-b px-3 py-2.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 lg:hidden"
                  aria-label="Back to messages"
                  onClick={closeThread}
                >
                  <ChevronLeft className="size-5" />
                </Button>
                <UserAvatar user={activeConv.peer} className="size-9 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1 truncate text-sm font-semibold">
                    {peerName(activeConv)}
                    {activeConv.peer?.verified ? (
                      <VerifiedBadge className="size-4" />
                    ) : null}
                  </p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Lock className="size-3" />
                    Encrypted end-to-end
                  </p>
                </div>
                {confirmDelete ? (
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleDelete()}
                    >
                      Delete
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete conversation"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>

              {confirmDelete ? (
                <div className="border-b border-oxide/30 bg-oxide/10 px-4 py-2.5 text-xs text-oxide dark:text-oxide-light">
                  Deleting removes this conversation for both of you. PureWire
                  keeps no copy anywhere — this can&apos;t be undone.
                </div>
              ) : null}

              {keyIssue === "peer-no-key" ? (
                <div className="border-b px-4 py-3 text-sm text-muted-foreground">
                  <ShieldCheck className="mr-2 inline size-4 text-primary" />
                  They haven&apos;t opened Messages yet, so their encryption key
                  isn&apos;t ready. Ask them to open Messages once — then chat
                  unlocks here.
                </div>
              ) : null}
              {keyIssue === "failed" ? (
                <div className="border-b px-4 py-3 text-sm text-muted-foreground">
                  <Lock className="mr-2 inline size-4 text-oxide" />
                  This device can&apos;t unlock this conversation. Messages
                  before this device first opened the thread stay unreadable
                  here by design.
                </div>
              ) : null}

              {/* Messages */}
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 sm:p-4">
                {status === "LoadingFirstPage" ? (
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 rounded-2xl" />
                    ))}
                  </div>
                ) : null}
                {status === "CanLoadMore" ? (
                  <div className="flex justify-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => loadMore(30)}
                    >
                      Load older messages
                    </Button>
                  </div>
                ) : null}
                {messages.map((m) => {
                  const mine = m.senderId === user?._id;
                  const text = decrypted[m._id];
                  const mediaUrl = mediaUrls[m._id];
                  // A media-only message legitimately has no text; only a
                  // message WITH text that failed to decrypt is undecryptable.
                  const undecryptable = m.ciphertext !== "" && text === "";
                  return (
                    <div
                      key={m._id}
                      className={cn(
                        "flex flex-col",
                        mine ? "items-end" : "items-start",
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm sm:max-w-[70%]",
                          mine
                            ? "rounded-br-md bg-primary text-primary-foreground"
                            : "rounded-bl-md bg-muted",
                        )}
                      >
                        {undecryptable ? (
                          <p className="flex items-center gap-1.5 italic opacity-80">
                            <Lock className="size-3.5" />
                            This message can&apos;t be decrypted on this device
                          </p>
                        ) : (
                          <>
                            {text ? (
                              <p className="whitespace-pre-wrap break-words">
                                {text}
                              </p>
                            ) : null}
                            {m.media ? (
                              <div className={cn(text && "mt-1.5")}>
                                {mediaUrl === undefined ? (
                                  <div className="flex items-center gap-2 text-xs opacity-80">
                                    <Loader2 className="size-3.5 animate-spin" />
                                    Decrypting attachment…
                                  </div>
                                ) : m.media.kind === "image" ? (
                                  <img
                                    src={mediaUrl}
                                    alt=""
                                    className="max-h-72 rounded-lg object-cover"
                                  />
                                ) : m.media.kind === "video" ? (
                                  <video
                                    src={mediaUrl}
                                    controls
                                    className="max-h-72 rounded-lg"
                                  />
                                ) : (
                                  <audio
                                    src={mediaUrl}
                                    controls
                                    className="h-10 w-56 max-w-full"
                                  />
                                )}
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                      <span className="mt-0.5 px-1 text-[11px] text-muted-foreground">
                        {timeAgo(m._creationTime)}
                      </span>
                    </div>
                  );
                })}
                <div ref={endRef} />
              </div>

              {/* Composer */}
              <div className="border-t p-3">
                {pendingMedia ? (
                  <div className="mb-2 flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      {pendingMedia.kind === "video" ? (
                        <Film className="size-4" />
                      ) : pendingMedia.kind === "audio" ? (
                        <AudioLines className="size-4" />
                      ) : (
                        <Paperclip className="size-4" />
                      )}
                      Attachment ready — encrypted before upload
                    </span>
                    <button
                      type="button"
                      aria-label="Remove attachment"
                      className="ml-auto text-muted-foreground hover:text-foreground"
                      onClick={() => setPendingMedia(null)}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ) : null}
                <div className="flex items-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    disabled={!convKey || sending}
                    aria-label="Attach media"
                    onClick={() => fileRef.current?.click()}
                  >
                    <Paperclip className="size-4" />
                  </Button>
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={
                      convKey
                        ? "Say it anyway — encrypted…"
                        : "Waiting for the encryption key…"
                    }
                    rows={1}
                    disabled={!convKey || keyIssue !== null || sending}
                    className="max-h-32 min-h-10 flex-1 resize-none"
                  />
                  <Button
                    size="icon"
                    className="shrink-0"
                    disabled={
                      !convKey ||
                      keyIssue !== null ||
                      sending ||
                      (draft.trim() === "" && pendingMedia === null)
                    }
                    aria-label="Send"
                    onClick={() => void send()}
                  >
                    {sending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                  </Button>
                </div>
                <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Lock className="size-3" />
                  Encrypted on your device. PureWire can&apos;t read it — and
                  can&apos;t hand it over.
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*,audio/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void pickFile(file);
          e.target.value = "";
        }}
      />

      {/* New message */}
      {newOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          onClick={() => setNewOpen(false)}
        >
          <div
            className="flex max-h-[80dvh] w-full max-w-md flex-col rounded-t-2xl border bg-background p-4 shadow-xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-bold tracking-tight">New message</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close"
                onClick={() => setNewOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or @handle"
                className="w-full rounded-xl border bg-transparent py-2.5 pl-9 pr-3 text-sm outline-none ring-ring focus:ring-2"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {search.trim().length < 2 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  Type at least two characters to find someone.
                </p>
              ) : searchResults === undefined ? (
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
                        {result.verified ? <VerifiedBadge className="size-4" /> : null}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        @{result.username}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
