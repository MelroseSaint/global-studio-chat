import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { getAuthUserId } from "@convex-dev/auth/server";

import { mediaHashesMatch } from "@/lib/perceptual-hash";
import { scanForRacism } from "@/lib/racism-guard";

import { AI_MEDIA_STATUS, scanText } from "./aiContent";
import { requireProof } from "./pow";
import { scanBlockedContent } from "./blocklist";
import { cloudinaryConfig } from "./mediaStorage";
import { parseUrlHost } from "./phishing";
import {
  boundingBox,
  cleanLocationLabel,
  isValidLocation,
  locationValidator,
} from "./location";
import {
  cleanupMediaItems,
  sweepCommentLikes,
  sweepPostEngagement,
} from "./mediaCleanup";
import { textMatchesMutes } from "./mutes";
import { publicLocation, publicUser } from "./privacy";
import {
  enforceActive,
  enforceRateLimit,
  enforceRateLimitResult,
  escalateForAiSpam,
  escalateSilently,
  hiddenAuthorIds,
  isSandboxed,
  silencedAuthorIds,
} from "./security";

import type { Doc, Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

/**
 * Sitemap feed — the newest public posts an anonymous crawler can
 * actually render (mirrors getPost with a null viewer: only posts pending
 * AI review are invisible, everything else is public). Internal only: the
 * /sitemap.xml httpAction is the sole caller, so clients never get a bulk
 * listing API.
 */
export const listPublicPostsForSitemap = internalQuery({
  handler: async (ctx) => {
    // Newest 1000 — generous for crawl coverage, bounded so the sitemap
    // endpoint never scans the whole table per cache miss.
    const posts = await ctx.db.query("posts").order("desc").take(1000);
    const out: { id: Id<"posts">; lastmod: number }[] = [];
    for (const post of posts) {
      // Pending AI review → getPost returns null anonymously → the OG
      // page 404s, so the URL must not be submitted.
      if (post.aiStatus === "review") continue;
      out.push({ id: post._id, lastmod: post._creationTime });
    }
    return out;
  },
});

/**
 * Simple FNV-1a fingerprint used to verify content originality.
 * Every post is checked against recent posts before it goes live:
 * PureWire only allows verified original content on the feed.
 */
function fingerprint(content: string): string {
  let hash = 0x811c9dc5;
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Word-bigram shingles of a post body, hashed, capped at a fixed size.
 * Stored on the post as `textTokens` so near-duplicate copies — lightly
 * reworded text that defeats the exact fingerprint — can be compared by
 * Jaccard similarity. Hashed so the stored tokens never reconstruct the
 * original words (privacy stays whole).
 */
function textShingles(content: string): string[] {
  const words = content
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
  const set = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) {
    const shingle = `${words[i]}|${words[i + 1]}`;
    let hash = 0x811c9dc5;
    for (let j = 0; j < shingle.length; j++) {
      hash ^= shingle.charCodeAt(j);
      hash = Math.imul(hash, 0x01000193);
    }
    set.add((hash >>> 0).toString(36));
  }
  const arr = [...set];
  if (arr.length <= 128) return arr;
  // Deterministic cap keeps long posts bounded while preserving a spread
  // of the set, so similarity stays meaningful for verbose text.
  const step = Math.ceil(arr.length / 128);
  const capped: string[] = [];
  for (let i = 0; i < arr.length; i += step) capped.push(arr[i]);
  return capped;
}

/** Jaccard similarity between two shingle sets. */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let intersection = 0;
  for (const x of a) {
    if (setB.has(x)) intersection++;
  }
  const union = a.length + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Posts sharing at least this fraction of word shingles count as copies. */
const TEXT_SIMILARITY_THRESHOLD = 0.7;

/**
 * Minimum shingle count before text similarity is meaningful. Bigram
 * overlap on tiny texts is pure noise — a two-word post has one shingle,
 * so sharing it would score 1.0 for phrases as ordinary as "good morning".
 * The exact fingerprint already catches verbatim copies at any length.
 */
const MIN_SHINGLES_FOR_SIMILARITY = 5;

/** True when any candidate media item's hash set matches any stored set. */
function anyMediaMatches(
  candidate: string[][],
  stored: string[][] | undefined,
): boolean {
  if (stored === undefined || stored.length === 0) return false;
  for (const item of candidate) {
    if (mediaHashesMatch(item, stored)) return true;
  }
  return false;
}

/**
 * Verify a post is original against recent posts — twice:
 *
 * 1. Exact fingerprint match (same normalized text), the cheapest check.
 * 2. Near-duplicates: evasive copies (flipped media, light crops, speed
 *    shifts, re-encodes, lightly reworded text) defeat the fingerprint,
 *    so compare shingle similarity and perceptual-hash distance against
 *    the most recent posts. Bounded so the scan cost stays flat.
 */
async function isDuplicate(
  ctx: MutationCtx,
  authorId: Id<"users">,
  fp: string | undefined,
  tokens: string[],
  mediaHashes: string[][],
): Promise<{ kind: "stolen" } | { kind: "own-recent" } | null> {
  if (fp !== undefined) {
    const recent = await ctx.db
      .query("posts")
      .withIndex("by_fingerprint", (q) => q.eq("fingerprint", fp))
      .filter((row) =>
        row.gte(row.field("_creationTime"), Date.now() - 7 * 24 * 3600_000),
      )
      .take(5);
    for (const post of recent) {
      // Prevent stealing another user's content and oversaturation.
      if (post.authorId !== authorId) {
        return { kind: "stolen" };
      }
    }
    const own = recent.find((p) => p.authorId === authorId);
    if (own && Date.now() - own._creationTime < 5 * 60_000) {
      return { kind: "own-recent" };
    }
  }
  if (tokens.length > 0 || mediaHashes.length > 0) {
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    const recent = await ctx.db.query("posts").order("desc").take(200);
    for (const post of recent) {
      if (post._creationTime < cutoff) continue;
      const textClose =
        tokens.length >= MIN_SHINGLES_FOR_SIMILARITY &&
        post.textTokens !== undefined &&
        post.textTokens.length >= MIN_SHINGLES_FOR_SIMILARITY &&
        jaccardSimilarity(tokens, post.textTokens) >= TEXT_SIMILARITY_THRESHOLD;
      const mediaClose = anyMediaMatches(mediaHashes, post.mediaHashes);
      if (!textClose && !mediaClose) continue;
      if (post.authorId !== authorId) {
        return { kind: "stolen" };
      }
      if (Date.now() - post._creationTime < 5 * 60_000) {
        return { kind: "own-recent" };
      }
    }
  }
  return null;
}

/**
 * Resolve @username mentions in content to the tagged users' ids (existing
 * accounts, excluding the author). Shared by tag storage and mention
 * notifications so the visible "with @alice" line on a post and the
 * notification inbox always agree.
 */
async function resolveMentionIds(
  ctx: MutationCtx,
  content: string,
  authorId: Id<"users">,
): Promise<Id<"users">[]> {
  const mentions = [...content.matchAll(/@([a-z0-9_]{3,24})/gi)].map((m) =>
    m[1].toLowerCase(),
  );
  const unique = [...new Set(mentions)];
  const ids: Id<"users">[] = [];
  for (const username of unique) {
    const target = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .first();
    if (target !== null && target._id !== authorId) {
      ids.push(target._id);
    }
  }
  return ids;
}

/** Notify every @username mentioned in content, linking to the post. */
async function notifyMentions(
  ctx: MutationCtx,
  content: string,
  authorId: Id<"users">,
  postId: Id<"posts">,
) {
  const ids = await resolveMentionIds(ctx, content, authorId);
  for (const userId of ids) {
    await ctx.db.insert("notifications", {
      userId,
      type: "mention",
      actorId: authorId,
      postId,
      read: false,
    });
  }
}

/** The shape createPost/createPostInternal both return. Explicitly typed so
 * the action's return never flows through the generated `internal` namespace
 * (TS7022 — see the same pattern in links.ts/media.ts). */
type CreatePostResult =
  | {
      ok: true;
      postId: Id<"posts">;
      aiReviewReason?: string;
      // Positive C2PA provenance the server verified (see scanMediaForAi).
      c2paVerifiedHuman?: boolean;
    }
  | { ok: false; error: string };

export const createPost = action({
  args: {
    content: v.string(),
    // Required creator declaration: how this work was made. "ai-generated"
    // is rejected outright; "ai-assisted" is allowed but flagged for review
    // with a visible disclosure chip on the post.
    creatorDisclosure: v.union(
      v.literal("human-made"),
      v.literal("ai-assisted"),
      v.literal("ai-generated"),
    ),
    media: v.optional(
      v.array(
        v.object({
          // Dual-mode: a Convex storage id (legacy/fallback) OR an external
          // Cloudinary url + key (primary path once CLOUDINARY_* is set).
          storageId: v.optional(v.id("_storage")),
          url: v.optional(v.string()),
          key: v.optional(v.string()),
          kind: v.union(
            v.literal("image"),
            v.literal("video"),
            v.literal("audio"),
          ),
          // True when GPS/device metadata was removed from this item — by
          // the client re-encode or the server-side remux. Surfaced as the
          // "Metadata stripped" note next to the post's media.
          stripped: v.optional(v.boolean()),
        }),
      ),
    ),
    // Perceptual hash sets per attached media item, computed in the browser
    // (original + mirrored + center-crop variants, sampled video frames).
    // Compared by Hamming distance against recent posts so flipped, cropped,
    // re-encoded, and speed-shifted copies still count as duplicates.
    mediaHashes: v.optional(v.array(v.array(v.string()))),
    // Kept for API compatibility — the client still sends its scan verdict,
    // but this action IGNORES it and recomputes the verdict server-side by
    // reading the actual media bytes (see the handler). The internal
    // mutation is the only writer and receives only the verified verdict.
    aiMediaStatus: v.optional(AI_MEDIA_STATUS),
    // Optional place the post was shared from (see the Local feed).
    location: v.optional(locationValidator),
    // Client-side proof-of-work (hashcash): the browser solves a ~50 ms
    // puzzle before submitting. Verified here — a bot that wants to flood
    // the API has to burn proportional CPU per attempt on top of the
    // server-side rate limits.
    powChallenge: v.optional(v.string()),
    powNonce: v.optional(v.string()),
    powIssuedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    {
      content,
      creatorDisclosure,
      media,
      mediaHashes,
      location,
      powChallenge,
      powNonce,
      powIssuedAt,
    },
  ): Promise<CreatePostResult> => {
    // The action is the public gate for post creation. It authenticates,
    // then VERIFIES the media itself (reading the actual stored bytes via
    // scanMediaForAi — actions can read storage, mutations cannot) instead
    // of trusting the client's reported verdict, then delegates the atomic
    // write to createPostInternal. A direct API caller sending
    // aiMediaStatus:"clean" with AI-generated bytes gets the real verdict.
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError("Not authenticated");
    }
    // Proof-of-work gate: verify before ANY scan or DB work so a flood of
    // forged payloads never reaches the expensive media pipeline.
    await requireProof(powChallenge, powNonce, powIssuedAt);
    let verifiedStatus: "clean" | "review" | "blocked" = "clean";
    // Positive Content Credentials provenance: true when any attached item's
    // C2PA manifest declared a camera capture. Verified server-side from
    // the stored bytes (never accepted from the client), then stored on the
    // post so viewers see the "Content Credentials verified" label.
    let c2paVerifiedHuman: boolean | undefined;
    let c2paClaimGenerator: string | undefined;
    // Structured evidence from the multi-signal media assessment — byte
    // scan verdict, C2PA provenance, OCR racism —
    // stored on the post so the admin review queue has the full picture.
    let aiEvidence: Record<string, unknown> | undefined;
    if (media !== undefined && media.length > 0) {
      const scan = await ctx.runAction(api.aiContent.scanMediaForAi, {
        media: media.map((m) => ({
          storageId: m.storageId,
          url: m.url,
          kind: m.kind,
        })),
      });
      verifiedStatus = scan.status;
      // evidence is always present in the new return shape (v.any() in the
      // validator — cast to access it).
      aiEvidence = (scan as unknown as { evidence?: Record<string, unknown> }).evidence;
      if (scan.status === "clean") {
        c2paVerifiedHuman = scan.c2paVerifiedHuman;
        c2paClaimGenerator = (scan as { c2paClaimGenerator?: string }).c2paClaimGenerator;
      }
    }
    return (await ctx.runMutation(
      internal.posts.createPostInternal,
      {
        content,
        creatorDisclosure,
        media,
        mediaHashes,
        aiMediaStatus: verifiedStatus,
        c2paVerifiedHuman,
        c2paClaimGenerator,
        aiEvidence,
        location,
      },
    )) as CreatePostResult;
  },
});

export const createPostInternal = internalMutation({
  args: {
    content: v.string(),
    creatorDisclosure: v.union(
      v.literal("human-made"),
      v.literal("ai-assisted"),
      v.literal("ai-generated"),
    ),
    media: v.optional(
      v.array(
        v.object({
          // Dual-mode: a Convex storage id (legacy/fallback) OR an external
          // Cloudinary url + key (primary path once CLOUDINARY_* is set).
          storageId: v.optional(v.id("_storage")),
          url: v.optional(v.string()),
          key: v.optional(v.string()),
          kind: v.union(
            v.literal("image"),
            v.literal("video"),
            v.literal("audio"),
          ),
          // True when GPS/device metadata was removed from this item — by
          // the client re-encode or the server-side remux. Surfaced as the
          // "Metadata stripped" note next to the post's media.
          stripped: v.optional(v.boolean()),
        }),
      ),
    ),
    // Perceptual hash sets per attached media item, computed in the browser
    // (original + mirrored + center-crop variants, sampled video frames).
    // Compared by Hamming distance against recent posts so flipped, cropped,
    // re-encoded, and speed-shifted copies still count as duplicates.
    mediaHashes: v.optional(v.array(v.array(v.string()))),
    // Verdict from the server-side scan (the createPost action reads the
    // actual bytes via scanMediaForAi before delegating here). This is the
    // ONLY writer of posts — the client claim is never trusted, the action
    // recomputes it against the stored bytes.
    aiMediaStatus: v.optional(AI_MEDIA_STATUS),
    // Positive Content Credentials provenance verified server-side from the
    // stored bytes (the createPost action computes it via scanMediaForAi;
    // the client can never set it). Stored so viewers see the
    // "Content Credentials verified" label.
    c2paVerifiedHuman: v.optional(v.boolean()),
    // The claim_generator from the C2PA manifest — which tool created the
    // credentials. Shown in the admin evidence panel.
    c2paClaimGenerator: v.optional(v.string()),
    // Structured evidence from the multi-signal media assessment — byte
    // scan, C2PA provenance, OCR racism. Stored
    // on the post so the admin review queue's evidence panel shows exactly
    // which signal triggered the flag (and with what confidence).
    aiEvidence: v.optional(v.any()),
    // Optional place the post was shared from (see the Local feed).
    location: v.optional(locationValidator),
  },
  handler: async (
    ctx,
    { content, creatorDisclosure, media, mediaHashes, aiMediaStatus, c2paVerifiedHuman, c2paClaimGenerator, aiEvidence, location },
  ) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      // ConvexError so the message survives the action → client boundary
      // (this mutation is invoked by the createPost action, never directly).
      throw new ConvexError("Not authenticated");
    }
    const text = content.trim();
    if (text.length === 0 && (media === undefined || media.length === 0)) {
      throw new ConvexError("Post must contain text or media.");
    }
    if (text.length > 1000) {
      throw new ConvexError("Post is too long (max 1000 characters).");
    }
    // Tags: every @username in the content is resolved to a real account
    // (the same lookup that fires mention notifications) and stored on the
    // post, so viewers see a structured "with @alice" line beneath it.
    const tags =
      text.length > 0 ? await resolveMentionIds(ctx, text, userId) : undefined;
    // Creator disclosure: "ai-generated" is rejected outright — the policy
    // is zero tolerance for AI-generated content.
    if (creatorDisclosure === "ai-generated") {
      throw new ConvexError(
        "AI-generated content is not allowed on PureWire. If you made this with AI tools, select 'AI-assisted' instead.",
      );
    }
    // ── Server-side media gate (enforced here, in the write path, so a
    // direct API caller gets exactly the same checks as the UI) ───────────
    // 1. Count cap: the UI allows at most 4 attachments; the mutation
    //    enforces the same bound because it is the final gate.
    const mediaItems = media ?? [];
    if (mediaItems.length > 4) {
      throw new ConvexError("A post can include up to 4 photos or videos.");
    }
    // 2. Shape + URL validation: every item must carry either a Convex
    //    storage id or an external https URL (never both, never neither),
    //    and external URLs must be https on PureWire's own media host — so
    //    a caller can't hotlink an arbitrary domain as "media" to bypass
    //    the link scanner, and can't pass a javascript:/data: URL.
    for (const item of mediaItems) {
      const hasStorage = item.storageId !== undefined;
      const hasUrl = item.url !== undefined;
      if (hasStorage === hasUrl) {
        throw new ConvexError("Each media item needs either a storage id or a URL.");
      }
      if (hasUrl) {
        const url = item.url ?? "";
        let host: string | null = null;
        try {
          host = parseUrlHost(url);
        } catch {
          host = null;
        }
        if (host === null || !/^https:\/\//i.test(url)) {
          throw new ConvexError("Media URLs must be https.");
        }
        // Cloudinary serves PureWire's media from res.cloudinary.com. A
        // hotlinked foreign host (adult CDN, phishing page) can never ride
        // in as media. When Cloudinary isn't configured (Convex-storage
        // fallback mode) external URLs are never legitimate — the upload
        // pipeline only produces storage ids then — so they're rejected
        // outright instead of passing an empty allowlist.
        const cfg = cloudinaryConfig();
        if (cfg === null) {
          throw new ConvexError("Media URLs are disabled while storage is in fallback mode.");
        }
        const allowed =
          host === "res.cloudinary.com" || host.endsWith(".res.cloudinary.com");
        if (!allowed) {
          throw new ConvexError("Media must be hosted by PureWire's media provider.");
        }
      }
    }
    // 3. Blocklist scan on every media URL: the same adult/phishing domain
    //    and pattern rules that guard post text must guard media links. A
    //    blocked media host is rejected (and counted toward a quiet
    //    shadowban) exactly like a blocked text link.
    for (const item of mediaItems) {
      if (item.url === undefined) continue;
      const mediaScan = await scanBlockedContent(ctx, item.url);
      if (mediaScan.status === "blocked") {
        await escalateSilently(ctx, userId, 3, "scam", "phish-block-media");
        return {
          ok: false,
          error:
            mediaScan.message ??
            "That media link is blocked on PureWire — nothing may link to adult platforms or phishing sites.",
        };
      }
      if (mediaScan.status === "review") {
        await escalateSilently(ctx, userId, 2, "scam", "phish-review-media");
      }
    }
    // A location is only meaningful within valid coordinates; label is
    // capped, and the stored point is coarsened to a ~1 km cell — the same
    // privacy treatment as home anchors, so no precise position is ever
    // persisted (the feed filter only needs neighborhood resolution). The
    // object is built explicitly (rather than via coarsenLocation, whose
    // coords are optional) because the posts schema requires them.
    const postLocation =
      location === undefined
        ? undefined
        : (() => {
            if (!isValidLocation(location)) {
              throw new ConvexError("Invalid location coordinates.");
            }
            return {
              latitude: Number(location.latitude.toFixed(2)),
              longitude: Number(location.longitude.toFixed(2)),
              label: cleanLocationLabel(location.label),
            };
          })();
    // Quiet sandbox: a shadowbanned or pending-review account's post is
    // accepted so nothing looks wrong to them, but silencedAuthorIds keeps
    // it invisible to everyone else until a human reviews the account.
    if (await isSandboxed(ctx, userId)) {
      const postId = await ctx.db.insert("posts", {
        authorId: userId,
        content: text,
        media,
        tags,
        aiStatus: "clean",
        aiEvidence,
        c2paVerifiedHuman,
        c2paClaimGenerator,
        creatorDisclosure,
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        reportCount: 0,
        location: postLocation,
      });
      // Server-side video privacy safety net: a client that skipped the
      // strip action (old build, API caller) still gets GPS/device atoms
      // removed moments after the post exists.
      const videoMedia = (media ?? []).filter((m) => m.kind === "video");
      if (videoMedia.length > 0) {
        await ctx.scheduler.runAfter(
          0,
          internal.videoStrip.stripVideoMetadataInternal,
          { postId, media: videoMedia },
        );
      }
      const me = await ctx.db.get(userId);
      await ctx.db.patch(userId, { postsCount: (me?.postsCount ?? 0) + 1 });
      return { ok: true, postId };
    }
    await enforceActive(ctx, userId);
    // Rate-limit breaches reject with a structured result (not a throw) so
    // the quiet flag survives: the budget-fill escalation commits in its own
    // transaction, and a thrown error would roll it back.
    if (!(await enforceRateLimitResult(ctx, userId, "post"))) {
      return {
        ok: false,
        error:
          "You're moving a little too fast. Slow down and try again in a moment.",
      };
    }
    const fp = text.length > 0 ? fingerprint(text) : undefined;
    const tokens = text.length > 0 ? textShingles(text) : [];
    if (fp !== undefined || tokens.length > 0 || (mediaHashes ?? []).length > 0) {
      const blocked = await isDuplicate(ctx, userId, fp, tokens, mediaHashes ?? []);
      if (blocked !== null) {
        // Reposting someone else's content is a strong spam signal — count
        // it toward a quiet shadowban. Your own recent re-posts are a gentle
        // nudge, never an escalation. This returns a structured rejection
        // instead of throwing: Convex mutations are atomic, so a throw would
        // roll back the escalation write and silently lose the flag. A
        // structured result commits both the flag and the rejection.
        if (blocked.kind === "stolen") {
          await escalateSilently(ctx, userId, 3, "duplicate", "duplicate-post");
        }
        return {
          ok: false,
          error:
            blocked.kind === "stolen"
              ? "This content already exists on PureWire. Only original posts are allowed."
              : "You've posted this recently. Please wait a moment.",
        };
      }
    }
    // Anti-AI enforcement: block clear AI content, flag suspicious text
    // for a human review in the admin dashboard.
    const textScan = scanText(text);
    if (textScan.status === "blocked") {
      // Self-identified AI content is rejected — and the rejection itself
      // is an abuse signal: posting machine-made text is the one shape of
      // AI abuse that never needed a queue. Escalated INLINE with the
      // structured result (a thrown error would roll the flag back — the
      // same atomicity the duplicate path handles), so a repeat offender
      // quietly accumulates toward a shadowban.
      await escalateSilently(ctx, userId, 3, "ai", "ai-blocked");
      // Accounts whose whole purpose is AI spam accelerate past the
      // one-off threshold toward a quiet shadowban (see security.ts).
      await escalateForAiSpam(ctx, userId);
      return {
        ok: false,
        error:
          "AI-generated content isn't allowed on PureWire. Say it yourself — in your own words.",
      };
    }
    if (aiMediaStatus === "blocked") {
      await escalateSilently(ctx, userId, 3, "ai", "ai-blocked");
      await escalateForAiSpam(ctx, userId);
      return {
        ok: false,
        error:
          "This media looks AI-generated, which isn't allowed on PureWire. Upload your own original work.",
      };
    }
    // Phishing and account-integrity enforcement: links and phrasing that
    // try to harvest accounts, passwords, money, or personal information
    // are rejected outright — and the rejection is itself an abuse signal,
    // escalated INLINE with the structured result (a thrown error would
    // roll the flag back), so repeat scammers quietly shadowban. The scan
    // combines the static heuristics with the DB-backed blocklist (admins
    // add/sync domains there), and caches each URL's verdict hashed.
    const phishScan = await scanBlockedContent(ctx, text);
    if (phishScan.status === "blocked") {
      await escalateSilently(ctx, userId, 3, "scam", "phish-block-post");
      return {
        ok: false,
        // Platform-rule blocks (e.g. adult platforms) carry their own
        // sentence; scam signals keep the generic warning.
        error:
          phishScan.message ??
          "That looks like a phishing or scam link — nothing on PureWire may try to steal accounts, money, or personal information.",
      };
    }
    // If media is present but no scan verdict was provided (e.g. a client
    // that never ran the scan action), send it to the human review queue
    // instead of trusting it as clean.
    const mediaVerdict: "clean" | "review" | "blocked" =
      media !== undefined && media.length > 0 && aiMediaStatus === undefined
        ? "review"
        : (aiMediaStatus ?? "clean");
    let needsReview =
      textScan.status === "review" ||
      mediaVerdict === "review" ||
      phishScan.status === "review";
    // Why the post was flagged, surfaced in the admin review queue so a
    // human can judge the flag at a glance instead of re-reading the post.
    let aiStatusReason =
      textScan.status === "review" && mediaVerdict === "review"
        ? [
            textScan.reason,
            aiMediaStatus === undefined
              ? "Media uploaded without a scan verdict — reviewed by default."
              : "Media flagged by the AI-generator metadata scan.",
          ].join(" · ")
        : textScan.status === "review"
          ? textScan.reason
          : mediaVerdict === "review"
            ? aiMediaStatus === undefined
              ? "Media uploaded without a scan verdict — reviewed by default."
              : "Media flagged by the AI-generator metadata scan."
            : undefined;
    // A phishing-suspicious post goes to the same human queue, with its
    // own honest reason — the author learns *why* their post is waiting.
    // scanForPhishing's review reason already carries the "Suspected
    // phishing —" prefix, so it is used as-is (no double prefix).
    if (phishScan.status === "review") {
      aiStatusReason = `${phishScan.reason}${
        aiStatusReason !== undefined ? ` · ${aiStatusReason}` : ""
      }`;
    }
    // ── Racism scan: the same pipeline (block → reject, review → queue) ──
    const racismScan = scanForRacism(text);
    if (racismScan.status === "blocked") {
      await escalateSilently(ctx, userId, 5, "harassment", "racism-block-post");
      return {
        ok: false,
        error: `That can't be posted — ${racismScan.reason}.`,
      };
    }
    let racismReviewCategory: string | undefined;
    let racismEvasionScore: number | undefined;
    if (racismScan.status === "review") {
      needsReview = true;
      racismReviewCategory = racismScan.category;
      racismEvasionScore = racismScan.evasionScore;
      aiStatusReason =
        aiStatusReason !== undefined
          ? `${aiStatusReason} · ${racismScan.reason}`
          : racismScan.reason;
    }
    // AI-assisted disclosure: allowed but flagged for human review (a human
    // used tools; the work is primarily theirs, but the platform verifies —
    // the disclosure chip is visible on the post and the review queue sees
    // the declaration). Triggers only when no other scan already flagged it.
    if (creatorDisclosure === "ai-assisted" && !needsReview) {
      needsReview = true;
      aiStatusReason =
        aiStatusReason !== undefined
          ? `${aiStatusReason} · Creator disclosed AI assistance`
          : "Creator disclosed AI assistance";
    }
    if (needsReview) {
      // Repeated suspicious content moves an account toward a quiet
      // shadowban instead of an abrupt ban. Phishing-suspicious content
      // counts as its own signal so the Silenced tab can show the mix.
      // NOTE: the AI-spam accelerator deliberately does NOT run here — the
      // review tier exists because the statistical scan false-positives on
      // genuine formal writers, so a human reviews these posts first and an
      // account is never accelerated toward a shadowban for merely tripping
      // the review queue. Only unambiguous AI hard-blocks accelerate.
      await escalateSilently(
        ctx,
        userId,
        2,
        phishScan.status === "review" ? "scam" : "ai",
        phishScan.status === "review" ? "phish-review-post" : "ai-review",
      );
    }
    const postId = await ctx.db.insert("posts", {
      authorId: userId,
      content: text,
      media,
      tags,
      fingerprint: fp,
      // Shingle tokens and media hash sets back the near-duplicate layer;
      // store them only when a check actually ran.
      textTokens: tokens.length > 0 ? tokens : undefined,
      mediaHashes: (mediaHashes ?? []).length > 0 ? mediaHashes : undefined,
      // Only claim originality when a fingerprint check actually ran.
      originalityVerified: fp !== undefined,
      aiStatus: needsReview ? "review" : "clean",
      aiStatusReason: needsReview ? aiStatusReason : undefined,
      // Racism-prevention review data: the matched category and evasion
      // score, stored so the racism-review admin tab can filter and label
      // posts without parsing aiStatusReason.
      racismReviewCategory,
      racismEvasionScore,
      // Content Credentials provenance the server verified from the stored
      // bytes — the "Content Credentials verified" label on the post.
      c2paVerifiedHuman,
      c2paClaimGenerator,
      // Structured evidence from the multi-signal media assessment.
      aiEvidence,
      creatorDisclosure,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      reportCount: 0,
      location: postLocation,
    });
    const me = await ctx.db.get(userId);
    await ctx.db.patch(userId, { postsCount: (me?.postsCount ?? 0) + 1 });
    // Server-side video privacy safety net, same as the sandboxed path:
    // anything the client didn't already strip gets cleaned here.
    const videoMedia = (media ?? []).filter((m) => m.kind === "video");
    if (videoMedia.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.videoStrip.stripVideoMetadataInternal,
        { postId, media: videoMedia },
      );
    }
    if (text.length > 0) {
      await notifyMentions(ctx, text, userId, postId);
    }
    return {
      ok: true,
      postId,
      // Honest "why": when the post enters human review, the author learns
      // immediately — and from the post itself (see the "under review" note
      // on their own views) — why their post isn't public yet, instead of
      // watching it silently disappear. Same signal list the admin queue
      // shows.
      aiReviewReason: needsReview ? aiStatusReason : undefined,
      c2paVerifiedHuman,
    };
  },
});

/**
 * Author (or admin) control: lock or unlock comments on a post. When
 * locked, no new comments can be added (existing ones stay readable).
 */
export const setCommentsLocked = mutation({
  args: { postId: v.id("posts"), locked: v.boolean() },
  handler: async (ctx, { postId, locked }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const post = await ctx.db.get(postId);
    if (post === null) return;
    const user = await ctx.db.get(userId);
    if (post.authorId !== userId && user?.role !== "admin") {
      throw new Error("You can only lock comments on your own posts.");
    }
    await ctx.db.patch(postId, {
      commentsLocked: locked,
      commentsLockedAt: locked ? Date.now() : undefined,
    });
  },
});

export const deletePost = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const post = await ctx.db.get(postId);
    if (post === null) {
      return;
    }
    const user = await ctx.db.get(userId);
    if (post.authorId !== userId && user?.role !== "admin") {
      throw new Error("You can only delete your own posts.");
    }
    // The files die with the post — Convex storage ids inline, external
    // Cloudinary keys through the fire-and-forget batch delete.
    await cleanupMediaItems(ctx, post.media ?? []);
    // The engagement rows die with the post too. Likes, comments, and
    // shares pointing at it are removed so no orphan rows linger (they
    // would inflate the admin dashboard's totals and never be reachable
    // again). The post's own like/comment/share counters die with the
    // row — nothing else needs decrementing here.
    await sweepPostEngagement(ctx, postId);
    // If this post was a SHARE, the share row it recorded against the
    // original and the original's shareCount die with it, so the count on
    // the original post stays honest when a share is removed.
    const sharedFromId = post.sharedFromId;
    if (sharedFromId !== undefined) {
      const target = await ctx.db.get(sharedFromId);
      if (target !== null) {
        const shareRow = await ctx.db
          .query("shares")
          .withIndex("by_post", (q) => q.eq("postId", sharedFromId))
          .filter((r) => r.eq(r.field("userId"), post.authorId))
          .first();
        if (shareRow !== null) {
          await ctx.db.delete(shareRow._id);
          await ctx.db.patch(target._id, {
            shareCount: Math.max(0, target.shareCount - 1),
          });
        }
      }
    }
    await ctx.db.delete(postId);
    // Keep the author's postsCount honest — the admin's moderatePost
    // decrements, and so must the user-facing delete, or the profile count
    // drifts upward with every post a member removes.
    const author = await ctx.db.get(post.authorId);
    if (author !== null) {
      await ctx.db.patch(author._id, {
        postsCount: Math.max(0, (author.postsCount ?? 0) - 1),
      });
    }
  },
});

async function withMedia(ctx: QueryCtx, user: Doc<"users"> | null) {
  if (user === null) {
    return null;
  }
  const [avatarUrl, bannerUrl] = await Promise.all([
    // Dual-mode: an external Cloudinary URL wins; otherwise resolve the Convex
    // storage id (legacy/fallback path).
    user.avatarUrl ??
      (user.avatarStorageId ? ctx.storage.getUrl(user.avatarStorageId) : null),
    user.bannerUrl ??
      (user.bannerStorageId ? ctx.storage.getUrl(user.bannerStorageId) : null),
  ]);
  return { ...publicUser(user), avatarUrl, bannerUrl };
}

/** A media item with its client-safe display URL resolved. */
type MediaWithUrl = Omit<
  NonNullable<Doc<"posts">["media"]>[number],
  "url"
> & {
  url: string | null;
};

/** Lightweight tagged-user preview attached to a post. */
interface TaggedUserView {
  _id: Id<"users">;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * A post enriched for clients: its author (with resolved artwork), display
 * URLs for its media, the users tagged in it, and — when the post is a
 * share — the original post embedded beneath it. Recursive (a share's
 * embedded original is itself a PostView) but bounded by design: shares
 * always point at originals, never at other shares.
 */
interface PostView extends Omit<Doc<"posts">, "location"> {
  // Coordinates are sensitive: clients see only the public label, even
  // though the server keeps them to power the Local feed filter.
  location: ReturnType<typeof publicLocation>;
  author: Awaited<ReturnType<typeof withMedia>>;
  likedByMe: boolean;
  mediaUrls: MediaWithUrl[] | undefined;
  taggedUsers: TaggedUserView[] | undefined;
  sharedFrom: PostView | null | undefined;
}

async function withAuthor(
  ctx: QueryCtx,
  post: Doc<"posts">,
  viewerId: Id<"users"> | null,
): Promise<PostView> {
  const author = await withMedia(ctx, await ctx.db.get(post.authorId));
  let likedByMe = false;
  if (viewerId !== null) {
    const like = await ctx.db
      .query("likes")
      .withIndex("by_pair", (q) =>
        q.eq("userId", viewerId).eq("postId", post._id),
      )
      .first();
    likedByMe = like !== null;
  }
  const mediaUrls = post.media
    ? await Promise.all(
        post.media.map(async (m) => ({
          ...m,
          // Dual-mode: an external Cloudinary URL wins; otherwise resolve the
          // Convex storage id (legacy/fallback path).
          url:
            m.url ??
            (m.storageId ? await ctx.storage.getUrl(m.storageId) : null),
        })),
      )
    : undefined;
  // Tags: lightweight previews of every tagged user (kept in sync with the
  // mention notifications fired at creation), so the client can render the
  // "with @alice and @bob" line without a second query.
  let taggedUsers:
    | {
        _id: Id<"users">;
        username: string | null;
        name: string | null;
        avatarUrl: string | null;
      }[]
    | undefined;
  if (post.tags !== undefined && post.tags.length > 0) {
    taggedUsers = (
      await Promise.all(
        post.tags.map(async (id) => {
          const u = await ctx.db.get(id);
          if (u === null) {
            return null;
          }
          return {
            _id: u._id,
            username: u.username ?? null,
            name: u.name ?? null,
            // Dual-mode: an external Cloudinary URL wins; otherwise resolve
            // the Convex storage id (legacy/fallback path).
            avatarUrl:
              u.avatarUrl ??
              (u.avatarStorageId ? await ctx.storage.getUrl(u.avatarStorageId) : null),
          };
        }),
      )
    ).filter((t): t is NonNullable<typeof t> => t !== null);
  }
  // Shared post: the original embedded beneath a share, with its own author
  // and media, respecting the same visibility rules as the feed — blocked,
  // banned, silenced, or pending-review originals render as an unavailable
  // note instead of leaking content, and a deleted original does the same.
  let sharedFrom: PostView | null | undefined;
  if (post.sharedFromId !== undefined) {
    const original = await ctx.db.get(post.sharedFromId);
    if (original === null) {
      sharedFrom = null;
    } else {
      const viewer = viewerId !== null ? await ctx.db.get(viewerId) : null;
      const hiddenIds = await hiddenAuthorIds(ctx, viewerId);
      const silencedIds = await silencedAuthorIds(ctx, viewerId);
      const invisible =
        hiddenIds.includes(original.authorId) ||
        silencedIds.includes(original.authorId);
      const pendingReview =
        original.aiStatus === "review" &&
        viewerId !== original.authorId &&
        viewer?.role !== "admin";
      sharedFrom = invisible || pendingReview ? null : await withAuthor(ctx, original, viewerId);
    }
  }
  return {
    ...post,
    // Coordinates are sensitive: clients see only the public label, even
    // though the server keeps them to power the Local feed filter.
    location: publicLocation(post.location),
    author,
    likedByMe,
    mediaUrls,
    taggedUsers,
    sharedFrom,
  };
}

export const feed = query({
  args: {
    paginationOpts: paginationOptsValidator,
    // PureWire has no algorithmic feed — users choose what they see.
    // "global" and "latest" both show the platform in time order today;
    // they stay distinct tabs so users control their view, and so a future
    // ranking layer can never be silently forced on anyone.
    // "local" shows posts shared near the viewer's location.
    filter: v.union(
      v.literal("global"),
      v.literal("following"),
      v.literal("latest"),
      v.literal("media"),
      v.literal("local"),
    ),
    // Viewer location + radius (km) for the "local" filter. When omitted,
    // the viewer's profile home location is used as the anchor.
    location: v.optional(locationValidator),
    radiusKm: v.optional(v.number()),
  },
  handler: async (ctx, { paginationOpts, filter, location, radiusKm }) => {
    const viewerId = await getAuthUserId(ctx);
    // Pick the tab's base query first…
    let base = ctx.db.query("posts");
    if (filter === "following" && viewerId !== null) {
      const follows = await ctx.db
        .query("follows")
        .withIndex("by_follower", (q) => q.eq("followerId", viewerId))
        .take(100);
      const authorIds = new Set([
        viewerId,
        ...follows.map((f) => f.followingId),
      ]);
      if (authorIds.size > 1) {
        base = ctx.db
          .query("posts")
          .filter((q) =>
            q.or(...[...authorIds].map((id) => q.eq(q.field("authorId"), id))),
          );
      }
      // Viewer follows nobody — keep the full feed as the base.
    } else if (filter === "media") {
      // The Media tab shows posts that render photos/videos: posts with
      // their own attachments, plus SHARES — a share has no media of its
      // own but renders the original post's media embedded beneath the
      // caption. Text-only shares (and shares whose original is gone or
      // hidden) are dropped after pagination below.
      base = ctx.db.query("posts").filter((q) =>
        q.or(
          q.neq(q.field("media"), undefined),
          q.neq(q.field("sharedFromId"), undefined),
        ),
      );
    } else if (filter === "local") {
      // Anchor the "nearby" search on the ephemeral location the client
      // passes — browser geolocation, held only for this one request and
      // never persisted. When the viewer hasn't granted live location,
      // fall back to their stored home anchor: a coarsened ~1 km cell
      // (never the precise point, and never sent to clients) read
      // server-side so the Local feed still works from their profile.
      let anchor = location;
      if (anchor === undefined && viewerId !== null) {
        const viewer = await ctx.db.get(viewerId);
        const home = viewer?.location;
        if (
          home !== null &&
          home !== undefined &&
          typeof home.latitude === "number" &&
          typeof home.longitude === "number"
        ) {
          anchor = { latitude: home.latitude, longitude: home.longitude };
        }
      }
      if (anchor === undefined) {
        // No live location and no stored anchor — the local tab is empty
        // until the viewer grants location or adds a home location.
        return { page: [], isDone: true, continueCursor: "" };
      }
      const radius = Math.min(Math.max(radiusKm ?? 50, 1), 1000);
      const box = boundingBox(anchor.latitude, anchor.longitude, radius);
      // Posts without a location have no matching field, so the gte/lte
      // comparisons naturally exclude them.
      base = ctx.db
        .query("posts")
        .filter((q) =>
          q.and(
            q.gte(q.field("location.latitude"), box.minLat),
            q.lte(q.field("location.latitude"), box.maxLat),
            q.gte(q.field("location.longitude"), box.minLng),
            q.lte(q.field("location.longitude"), box.maxLng),
          ),
        );
    }
    // …then apply the safety exclusions on every tab: accounts the viewer
    // blocked, accounts that blocked the viewer, banned accounts, accounts
    // awaiting admin approval, and quietly shadowbanned accounts — in both
    // directions. A silenced user still sees their own posts.
    const hiddenIds = await hiddenAuthorIds(ctx, viewerId);
    const silencedIds = await silencedAuthorIds(ctx, viewerId);
    const excludedIds = [...hiddenIds, ...silencedIds];
    if (excludedIds.length > 0) {
      base = base.filter((q) =>
        q.not(q.or(...excludedIds.map((id) => q.eq(q.field("authorId"), id)))),
      );
    }
    // Posts awaiting a human AI-review stay out of public feeds — except
    // for their author, who sees their own review posts with an "under
    // review" note (with the reason), so a genuine creator is never left
    // wondering where their post went. Signed-out viewers never see them.
    if (viewerId !== null) {
      base = base.filter((q) =>
        q.or(
          q.neq(q.field("aiStatus"), "review"),
          q.eq(q.field("authorId"), viewerId),
        ),
      );
    } else {
      base = base.filter((q) => q.neq(q.field("aiStatus"), "review"));
    }
    const result = await base.order("desc").paginate(paginationOpts);
    // Personal keyword muting: posts whose content mentions any muted term
    // are filtered after pagination (they still exist; they're just hidden
    // from this viewer). This keeps the index query untouched while giving
    // users real control over what enters their feed.
    let mutedKeywords: string[] | undefined;
    if (viewerId !== null) {
      const viewer = await ctx.db.get(viewerId);
      mutedKeywords = viewer?.mutedKeywords;
    }
    let page = await Promise.all(
      result.page.map((p) => withAuthor(ctx, p, viewerId)),
    );
    if (mutedKeywords !== undefined && mutedKeywords.length > 0) {
      page = page.filter((p) => !textMatchesMutes(p.content, mutedKeywords));
    }
    // Media tab: after resolving authors + embedded originals, keep only
    // the posts that actually render photos/videos — their own media, or a
    // share whose original carries media. Text-only shares and shares with
    // a deleted/hidden original (sharedFrom null) fall out here; they'd
    // only dilute a "Photos & videos" browse. Same post-pagination pattern
    // as the keyword muting above.
    if (filter === "media") {
      page = page.filter(
        (p) =>
          (p.mediaUrls?.length ?? 0) > 0 ||
          (p.sharedFrom?.mediaUrls?.length ?? 0) > 0,
      );
    }
    return { ...result, page };
  },
});

export const getPost = query({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const viewerId = await getAuthUserId(ctx);
    const post = await ctx.db.get(postId);
    if (post === null) {
      return null;
    }
    // Blocked, blocking, banned, pending-review, and shadowbanned authors
    // are invisible to the viewer.
    const hiddenIds = await hiddenAuthorIds(ctx, viewerId);
    const silencedIds = await silencedAuthorIds(ctx, viewerId);
    if (hiddenIds.includes(post.authorId) || silencedIds.includes(post.authorId)) {
      return null;
    }
    // Posts awaiting AI review are only visible to their author and admins.
    if (post.aiStatus === "review") {
      const viewer = viewerId !== null ? await ctx.db.get(viewerId) : null;
      const isAuthor = viewerId === post.authorId;
      if (!isAuthor && viewer?.role !== "admin") {
        return null;
      }
    }
    return await withAuthor(ctx, post, viewerId);
  },
});

export const likePost = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    // A sandboxed account's like is silently absorbed — it counts for the
    // liker's UI but never reaches the author or the public count.
    if (await isSandboxed(ctx, userId)) {
      const post = await ctx.db.get(postId);
      if (post !== null) {
        const absorbed = await ctx.db
          .query("likes")
          .withIndex("by_pair", (q) => q.eq("userId", userId).eq("postId", postId))
          .first();
        if (absorbed === null) {
          await ctx.db.insert("likes", { userId, postId });
        }
      }
      return;
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "like");
    const post = await ctx.db.get(postId);
    if (post === null) {
      throw new Error("Post not found");
    }
    const existing = await ctx.db
      .query("likes")
      .withIndex("by_pair", (q) => q.eq("userId", userId).eq("postId", postId))
      .first();
    if (existing !== null) {
      return;
    }
    await ctx.db.insert("likes", { userId, postId });
    await ctx.db.patch(postId, { likeCount: post.likeCount + 1 });
    if (post.authorId !== userId) {
      await ctx.db.insert("notifications", {
        userId: post.authorId,
        type: "like",
        actorId: userId,
        postId,
        read: false,
      });
    }
  },
});

export const unlikePost = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const post = await ctx.db.get(postId);
    if (post === null) {
      return;
    }
    const existing = await ctx.db
      .query("likes")
      .withIndex("by_pair", (q) => q.eq("userId", userId).eq("postId", postId))
      .first();
    if (existing === null) {
      return;
    }
    await ctx.db.delete(existing._id);
    await ctx.db.patch(postId, {
      likeCount: Math.max(0, post.likeCount - 1),
    });
  },
});

export const addComment = mutation({
  args: {
    postId: v.id("posts"),
    content: v.string(),
    // When set, this is a reply to that comment. Replies to a reply are
    // re-rooted to the top-level comment, so parentId always lands on a
    // top-level comment and the tree stays one level deep.
    parentId: v.optional(v.id("comments")),
    // The id of a post being shared into this comment (see schema.ts — the
    // reference is public metadata, rendered as a preview card).
    sharedPostId: v.optional(v.id("posts")),
    // Client-side proof-of-work, same scheme as createPost.
    powChallenge: v.optional(v.string()),
    powNonce: v.optional(v.string()),
    powIssuedAt: v.optional(v.number()),
  },
  handler: async (ctx, { postId, content, parentId: parentArg, sharedPostId, powChallenge, powNonce, powIssuedAt }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    await requireProof(powChallenge, powNonce, powIssuedAt);
    const text = content.trim();
    // No empty husks: a comment carries text, a shared post reference, or
    // both — mirroring the DM message rule.
    if (
      (text.length === 0 && sharedPostId === undefined) ||
      text.length > 500
    ) {
      throw new Error(
        sharedPostId === undefined
          ? "Comment must be between 1 and 500 characters."
          : "Comment text must be 500 characters or fewer.",
      );
    }
    // A shared post must exist at comment time — a preview that instantly
    // breaks is worse than a rejection. (It can still be deleted later;
    // the viewer's preview then degrades to "no longer available".)
    if (
      sharedPostId !== undefined &&
      (await ctx.db.get(sharedPostId)) === null
    ) {
      throw new Error("That post is no longer available");
    }
    // Comment control: a locked post stops ALL new comments (top-level and
    // replies). The author or an admin turned it off; the thread stays
    // readable but nothing new can be added.
    const lockPost = await ctx.db.get(postId);
    if (lockPost !== null && lockPost.commentsLocked === true) {
      throw new Error("Comments are disabled on this post.");
    }
    // Threaded replies: the parent must exist on the same post, and a reply
    // to a reply is re-rooted to the top-level comment so every reply hangs
    // directly under one parent. The parent's author gets the "reply"
    // notification instead of the post author.
    let parentId: Id<"comments"> | undefined;
    let parentAuthorId: Id<"users"> | null = null;
    if (parentArg !== undefined) {
      const parent = await ctx.db.get(parentArg);
      if (parent === null || parent.postId !== postId) {
        throw new Error("That comment isn't on this post.");
      }
      parentId = parent.parentId ?? parent._id;
      parentAuthorId = parent.authorId;
    }
    // A sandboxed account's comment is silently absorbed — stored for their
    // own UI but invisible to the author and everyone else.
    if (await isSandboxed(ctx, userId)) {
      const post = await ctx.db.get(postId);
      if (post !== null) {
        await ctx.db.insert("comments", {
          postId,
          authorId: userId,
          content: text,
          parentId,
          ...(sharedPostId !== undefined ? { sharedPostId } : {}),
        });
      }
      return { ok: true };
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "comment");
    // Comments get the full text scan, not just the block list: formulaic
    // machine-made comments are automatically detected and quietly counted
    // toward a shadowban (there is no comment-level review queue), while
    // self-identified AI comments are rejected outright.
    const textScan = scanText(text);
    if (textScan.status === "blocked") {
      // Rejected — and the rejection is itself an abuse signal. Escalated
      // INLINE with the structured result (a thrown error would roll the
      // flag back), so repeat AI commenters quietly shadowban.
      await escalateSilently(ctx, userId, 3, "ai", "ai-blocked");
      await escalateForAiSpam(ctx, userId);
      return {
        ok: false,
        error:
          "AI-generated content isn't allowed on PureWire. Say it in your own words.",
      };
    }
    if (textScan.status === "review") {
      // Review-tier only — never accelerated (see the post path note).
      await escalateSilently(ctx, userId, 1, "ai", "ai-review-comment");
    }
    // Comments get the phishing scan too (static + DB blocklist).
    // Blocked-tier is rejected outright and escalated; review-tier
    // (shorteners, unfamiliar login pages) is also rejected — comments
    // have no human queue, so the honest guidance is to share the direct
    // link instead.
    const phishScan = await scanBlockedContent(ctx, text);
    if (phishScan.status === "blocked") {
      await escalateSilently(ctx, userId, 3, "scam", "phish-block-comment");
      return {
        ok: false,
        error:
          phishScan.message ??
          "That looks like a phishing or scam link — links that could compromise someone's account aren't allowed.",
      };
    }
    if (phishScan.status === "review") {
      await escalateSilently(ctx, userId, 2, "scam", "phish-review-comment");
      return {
        ok: false,
        error:
          "This link can't be posted as-is — share the direct link instead.",
      };
    }
    // Racism scan: comments get the same check. Blocked is rejected;
    // review-tier is also rejected — comments have no human queue.
    const racismCommentScan = scanForRacism(text);
    if (racismCommentScan.status === "blocked") {
      await escalateSilently(ctx, userId, 5, "harassment", "racism-block-comment");
      return {
        ok: false,
        error: `That can't be posted — ${racismCommentScan.reason}.`,
      };
    }
    if (racismCommentScan.status === "review") {
      await escalateSilently(ctx, userId, 2, "harassment", "racism-review-comment");
      return {
        ok: false,
        error: `That may not be allowed — ${racismCommentScan.reason}. Rephrase or report the content you're responding to.`,
      };
    }
    const post = await ctx.db.get(postId);
    if (post === null) {
      throw new Error("Post not found");
    }
    await ctx.db.insert("comments", {
      postId,
      authorId: userId,
      content: text,
      parentId,
      ...(sharedPostId !== undefined ? { sharedPostId } : {}),
    });
    await ctx.db.patch(postId, { commentCount: post.commentCount + 1 });
    // A reply notifies the comment author they got a reply; a top-level
    // comment notifies the post author as before. Never self-notify.
    if (parentId !== undefined) {
      if (parentAuthorId !== null && parentAuthorId !== userId) {
        await ctx.db.insert("notifications", {
          userId: parentAuthorId,
          type: "reply",
          actorId: userId,
          postId,
          read: false,
        });
      }
      // The reply counter on the top-level comment this hangs under.
      const root = await ctx.db.get(parentId);
      if (root !== null) {
        await ctx.db.patch(parentId, {
          replyCount: (root.replyCount ?? 0) + 1,
        });
      }
    } else if (post.authorId !== userId) {
      await ctx.db.insert("notifications", {
        userId: post.authorId,
        type: "comment",
        actorId: userId,
        postId,
        read: false,
      });
    }
    return { ok: true };
  },
});

export const listComments = query({
  args: {
    postId: v.id("posts"),
    paginationOpts: paginationOptsValidator,
    // "top" ranks the thread by like count (highest first); "newest" keeps
    // the reverse-chronological order. The by_post_likes index serves the
    // top sort; comments missing likeCount (never liked) sort last.
    sort: v.optional(v.union(v.literal("newest"), v.literal("top"))),
  },
  handler: async (ctx, { postId, paginationOpts, sort }) => {
    const viewerId = await getAuthUserId(ctx);
    const hidden = await hiddenAuthorIds(ctx, viewerId);
    const silenced = await silencedAuthorIds(ctx, viewerId);
    const excluded = [...hidden, ...silenced];
    const result =
      sort === "top"
        ? await ctx.db
            .query("comments")
            .withIndex("by_post_parent_likes", (q) =>
              q.eq("postId", postId).eq("parentId", undefined),
            )
            .order("desc")
            .paginate(paginationOpts)
        : await ctx.db
            .query("comments")
            .withIndex("by_post_parent", (q) =>
              q.eq("postId", postId).eq("parentId", undefined),
            )
            .order("desc")
            .paginate(paginationOpts);
    const visible = result.page.filter((c) => !excluded.includes(c.authorId));
    const page = await Promise.all(
      visible.map(async (c) => {
        const author = await ctx.db.get(c.authorId);
        let likedByMe = false;
        if (viewerId !== null) {
          const like = await ctx.db
            .query("commentLikes")
            .withIndex("by_pair", (q) =>
              q.eq("userId", viewerId).eq("commentId", c._id),
            )
            .first();
          likedByMe = like !== null;
        }
        return {
          ...c,
          author: author ? publicUser(author) : null,
          likeCount: c.likeCount ?? 0,
          // Replies only — top-level comments report how many hang under
          // them so the UI can show the "View N replies" toggle.
          replyCount: c.replyCount ?? 0,
          likedByMe,
        };
      }),
    );
    return { ...result, page };
  },
});

/**
 * The replies hanging under one top-level comment, newest-first. Rendered
 * inside the comment's expandable "View replies" section on the post page
 * and in the popup preview. Same enrichment as listComments, so a reply
 * row behaves exactly like a comment row (author, like, edit, delete).
 */
export const listReplies = query({
  args: {
    postId: v.id("posts"),
    parentId: v.id("comments"),
    paginationOpts: paginationOptsValidator,
    sort: v.optional(v.union(v.literal("newest"), v.literal("top"))),
  },
  handler: async (ctx, { postId, parentId, paginationOpts, sort }) => {
    const viewerId = await getAuthUserId(ctx);
    const hidden = await hiddenAuthorIds(ctx, viewerId);
    const silenced = await silencedAuthorIds(ctx, viewerId);
    const excluded = [...hidden, ...silenced];
    const result =
      sort === "top"
        ? await ctx.db
            .query("comments")
            .withIndex("by_post_parent_likes", (q) =>
              q.eq("postId", postId).eq("parentId", parentId),
            )
            .order("desc")
            .paginate(paginationOpts)
        : await ctx.db
            .query("comments")
            .withIndex("by_post_parent", (q) =>
              q.eq("postId", postId).eq("parentId", parentId),
            )
            .order("desc")
            .paginate(paginationOpts);
    const visible = result.page.filter((c) => !excluded.includes(c.authorId));
    const page = await Promise.all(
      visible.map(async (c) => {
        const author = await ctx.db.get(c.authorId);
        let likedByMe = false;
        if (viewerId !== null) {
          const like = await ctx.db
            .query("commentLikes")
            .withIndex("by_pair", (q) =>
              q.eq("userId", viewerId).eq("commentId", c._id),
            )
            .first();
          likedByMe = like !== null;
        }
        return {
          ...c,
          author: author ? publicUser(author) : null,
          likeCount: c.likeCount ?? 0,
          likedByMe,
        };
      }),
    );
    return { ...result, page };
  },
});

/**
 * Remove a comment. Only its author (or an admin) may delete it; the
 * post's denormalized commentCount is kept honest so the badge on the
 * card and the thread page agree.
 */
export const deleteComment = mutation({
  args: { commentId: v.id("comments") },
  handler: async (ctx, { commentId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const comment = await ctx.db.get(commentId);
    if (comment === null) {
      return;
    }
    const user = await ctx.db.get(userId);
    if (comment.authorId !== userId && user?.role !== "admin") {
      throw new Error("You can only delete your own comments.");
    }
    const post = await ctx.db.get(comment.postId);
    // Replies die with their parent — each sweeps its own likes first — and
    // every removed row is accounted in the post's commentCount below. The
    // bounded sweep loop (not a collect) matches the erasure path, so a
    // very long reply thread can't balloon one mutation's memory.
    let removed = 1;
    for (;;) {
      const children = await ctx.db
        .query("comments")
        .withIndex("by_parent", (q) => q.eq("parentId", commentId))
        .take(500);
      if (children.length === 0) break;
      removed += children.length;
      for (const child of children) {
        await sweepCommentLikes(ctx, child._id);
        await ctx.db.delete(child._id);
      }
    }
    // If this comment was itself a reply, the parent's replyCount drops by
    // one (the parent survives; it just lost a reply).
    if (comment.parentId !== undefined) {
      const parent = await ctx.db.get(comment.parentId);
      if (parent !== null) {
        await ctx.db.patch(parent._id, {
          replyCount: Math.max(0, (parent.replyCount ?? 0) - 1),
        });
      }
    }
    // A sandboxed author's comment was inserted without ever incrementing
    // the post's commentCount (see addComment's sandbox path), so deleting
    // it must not decrement either — otherwise the count would drift.
    if (post !== null && !(await isSandboxed(ctx, comment.authorId))) {
      await ctx.db.patch(post._id, {
        commentCount: Math.max(0, post.commentCount - removed),
      });
    }
    // The comment's likes die with it — no orphan rows keyed to a deleted
    // comment.
    await sweepCommentLikes(ctx, commentId);
    await ctx.db.delete(commentId);
  },
});

/**
 * Edit a comment. Only its author may edit it. The replacement text gets
 * the exact same AI/phishing/racism scans as addComment — a clean comment
 * can never be swapped for a blocked one after the fact — and the row is
 * stamped with editedAt so viewers see a small "edited" note.
 */
export const editComment = mutation({
  args: {
    commentId: v.id("comments"),
    content: v.string(),
    // Client-side proof-of-work, same scheme as addComment.
    powChallenge: v.optional(v.string()),
    powNonce: v.optional(v.string()),
    powIssuedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { commentId, content, powChallenge, powNonce, powIssuedAt },
  ) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    await requireProof(powChallenge, powNonce, powIssuedAt);
    const text = content.trim();
    const comment = await ctx.db.get(commentId);
    if (comment === null) {
      throw new Error("Comment not found");
    }
    // A comment that carries a shared post may drop its caption entirely
    // (the card stands alone) — but the edit UI only ever edits text, so
    // this mirrors addComment's empty-husk rule.
    if (
      (text.length === 0 && comment.sharedPostId === undefined) ||
      text.length > 500
    ) {
      throw new Error("Comment must be between 1 and 500 characters.");
    }
    if (comment.authorId !== userId) {
      throw new Error("You can only edit your own comments.");
    }
    // A sandboxed account's comment is invisible to everyone else, so its
    // edits are stored silently without scans or escalation.
    if (await isSandboxed(ctx, userId)) {
      await ctx.db.patch(commentId, { content: text, editedAt: Date.now() });
      return { ok: true };
    }
    await enforceActive(ctx, userId);
    // ── Re-scan the replacement text, mirroring addComment ─────────────
    const textScan = scanText(text);
    if (textScan.status === "blocked") {
      await escalateSilently(ctx, userId, 3, "ai", "ai-blocked");
      await escalateForAiSpam(ctx, userId);
      return {
        ok: false,
        error:
          "AI-generated content isn't allowed on PureWire. Say it in your own words.",
      };
    }
    if (textScan.status === "review") {
      await escalateSilently(ctx, userId, 1, "ai", "ai-review-comment");
    }
    const phishScan = await scanBlockedContent(ctx, text);
    if (phishScan.status === "blocked") {
      await escalateSilently(ctx, userId, 3, "scam", "phish-block-comment");
      return {
        ok: false,
        error:
          phishScan.message ??
          "That looks like a phishing or scam link — links that could compromise someone's account aren't allowed.",
      };
    }
    if (phishScan.status === "review") {
      await escalateSilently(ctx, userId, 2, "scam", "phish-review-comment");
      return {
        ok: false,
        error:
          "This link can't be posted as-is — share the direct link instead.",
      };
    }
    const racismScan = scanForRacism(text);
    if (racismScan.status === "blocked") {
      await escalateSilently(ctx, userId, 5, "harassment", "racism-block-comment");
      return {
        ok: false,
        error: `That can't be posted — ${racismScan.reason}.`,
      };
    }
    if (racismScan.status === "review") {
      await escalateSilently(ctx, userId, 2, "harassment", "racism-review-comment");
      return {
        ok: false,
        error: `That may not be allowed — ${racismScan.reason}. Rephrase or report the content you're responding to.`,
      };
    }
    await ctx.db.patch(commentId, { content: text, editedAt: Date.now() });
    return { ok: true };
  },
});

/**
 * Like a comment. Mirrors likePost: a sandboxed account's like is silently
 * absorbed (a row exists for their own UI but never reaches the public
 * count or the author), and the comment's denormalized likeCount is only
 * bumped for real, visible likes.
 */
export const likeComment = mutation({
  args: { commentId: v.id("comments") },
  handler: async (ctx, { commentId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    if (await isSandboxed(ctx, userId)) {
      const comment = await ctx.db.get(commentId);
      if (comment !== null) {
        const existing = await ctx.db
          .query("commentLikes")
          .withIndex("by_pair", (q) =>
            q.eq("userId", userId).eq("commentId", commentId),
          )
          .first();
        if (existing === null) {
          await ctx.db.insert("commentLikes", { commentId, userId });
        }
      }
      return;
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "like");
    const comment = await ctx.db.get(commentId);
    if (comment === null) {
      throw new Error("Comment not found");
    }
    const existing = await ctx.db
      .query("commentLikes")
      .withIndex("by_pair", (q) =>
        q.eq("userId", userId).eq("commentId", commentId),
      )
      .first();
    if (existing !== null) {
      return;
    }
    await ctx.db.insert("commentLikes", { commentId, userId });
    await ctx.db.patch(commentId, {
      likeCount: (comment.likeCount ?? 0) + 1,
    });
  },
});

/** Remove your like from a comment. Mirrors unlikePost. */
export const unlikeComment = mutation({
  args: { commentId: v.id("comments") },
  handler: async (ctx, { commentId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    const comment = await ctx.db.get(commentId);
    if (comment === null) {
      return;
    }
    const existing = await ctx.db
      .query("commentLikes")
      .withIndex("by_pair", (q) =>
        q.eq("userId", userId).eq("commentId", commentId),
      )
      .first();
    if (existing === null) {
      return;
    }
    await ctx.db.delete(existing._id);
    // A sandboxed user's like was absorbed — the row existed but never
    // bumped the count (see likeComment's sandbox path), so removing it
    // must not decrement either.
    if (!(await isSandboxed(ctx, userId))) {
      await ctx.db.patch(commentId, {
        likeCount: Math.max(0, (comment.likeCount ?? 0) - 1),
      });
    }
  },
});

export const sharePost = mutation({
  args: { postId: v.id("posts") },
  handler: async (ctx, { postId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not authenticated");
    }
    // A sandboxed account's share is silently absorbed.
    if (await isSandboxed(ctx, userId)) {
      return;
    }
    await enforceActive(ctx, userId);
    await enforceRateLimit(ctx, userId, "share");
    const post = await ctx.db.get(postId);
    if (post === null) {
      throw new Error("Post not found");
    }
    const existing = await ctx.db
      .query("shares")
      .withIndex("by_pair", (q) => q.eq("userId", userId).eq("postId", postId))
      .first();
    if (existing !== null) {
      return;
    }
    await ctx.db.insert("shares", { postId, userId });
    await ctx.db.patch(postId, { shareCount: post.shareCount + 1 });
    if (post.authorId !== userId) {
      await ctx.db.insert("notifications", {
        userId: post.authorId,
        type: "share",
        actorId: userId,
        postId,
        read: false,
      });
    }
  },
});

/**
 * Facebook-style share: create a NEW post that embeds the original post
 * (with its media) beneath an optional caption. The share is a first-class
 * post — it appears in feeds and on the sharer's profile — and it counts
 * toward the original's shareCount, exactly like a repost. The caption is
 * post content, so it gets the same AI-text / phishing / racism scans as a
 * text-only post, and its @mentions notify the tagged users (see the tag
 * feature). Share chains are flattened: sharing a share always points at
 * the ORIGINAL post, never at another share, so no endless nesting.
 */
export const createShare = mutation({
  args: {
    postId: v.id("posts"),
    content: v.string(),
    // Client-side proof-of-work, same scheme as createPost/addComment.
    powChallenge: v.optional(v.string()),
    powNonce: v.optional(v.string()),
    powIssuedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { postId, content, powChallenge, powNonce, powIssuedAt },
  ) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError("Not authenticated");
    }
    await requireProof(powChallenge, powNonce, powIssuedAt);
    const caption = content.trim();
    if (caption.length > 1000) {
      throw new ConvexError(
        "Share caption is too long (max 1000 characters).",
      );
    }
    const original = await ctx.db.get(postId);
    if (original === null) {
      throw new ConvexError("This post is no longer available to share.");
    }
    // A share must respect the same visibility rules as the feed: content
    // from blocked, banned, or pending-review authors can't be amplified
    // into a fresh post.
    const hiddenIds = await hiddenAuthorIds(ctx, userId);
    if (hiddenIds.includes(original.authorId)) {
      throw new ConvexError("You can't share this post.");
    }
    if (original.aiStatus === "review" && original.authorId !== userId) {
      throw new ConvexError(
        "This post is still being reviewed and can't be shared yet.",
      );
    }
    // Flatten share chains: point at the original post, never at another
    // share. If the root was deleted since the share was made, fall back to
    // the post itself.
    let target = original;
    if (original.sharedFromId !== undefined) {
      const root = await ctx.db.get(original.sharedFromId);
      if (root !== null) {
        target = root;
      }
    }
    const tags =
      caption.length > 0
        ? await resolveMentionIds(ctx, caption, userId)
        : undefined;
    // Quiet sandbox: a shadowbanned or pending-review account's share is
    // accepted so nothing looks wrong to them, but stays invisible to
    // everyone else — and never counts toward the original's shareCount.
    if (await isSandboxed(ctx, userId)) {
      const shareId = await ctx.db.insert("posts", {
        authorId: userId,
        content: caption,
        sharedFromId: target._id,
        tags,
        aiStatus: "clean",
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        reportCount: 0,
      });
      const me = await ctx.db.get(userId);
      await ctx.db.patch(userId, { postsCount: (me?.postsCount ?? 0) + 1 });
      return { ok: true, postId: shareId };
    }
    await enforceActive(ctx, userId);
    // Rate-limit breaches reject with a structured result (not a throw) so
    // the quiet flag survives — same pattern as createPostInternal.
    if (!(await enforceRateLimitResult(ctx, userId, "share"))) {
      return {
        ok: false,
        error:
          "You're moving a little too fast. Slow down and try again in a moment.",
      };
    }
    // The caption is post content: it gets the same scans as a text-only
    // post — AI-text, phishing/blocklist, and racism — with review-tier
    // results routed to the human queue exactly like a regular post.
    let needsReview = false;
    let aiStatusReason: string | undefined;
    let racismReviewCategory: string | undefined;
    let racismEvasionScore: number | undefined;
    // Which signal sent the share to the human queue, mirroring the post
    // path's escalation source so the Silenced tab shows the same reasons.
    let reviewSignal: "ai" | "scam" = "ai";
    let reviewSource = "ai-review";
    if (caption.length > 0) {
      const textScan = scanText(caption);
      if (textScan.status === "blocked") {
        await escalateSilently(ctx, userId, 3, "ai", "ai-blocked");
        await escalateForAiSpam(ctx, userId);
        return {
          ok: false,
          error:
            "AI-generated content isn't allowed on PureWire. Say it yourself — in your own words.",
        };
      }
      if (textScan.status === "review") {
        needsReview = true;
        aiStatusReason = textScan.reason;
      }
      const phishScan = await scanBlockedContent(ctx, caption);
      if (phishScan.status === "blocked") {
        await escalateSilently(ctx, userId, 3, "scam", "phish-block-post");
        return {
          ok: false,
          error:
            phishScan.message ??
            "That looks like a phishing or scam link — nothing on PureWire may try to steal accounts, money, or personal information.",
        };
      }
      if (phishScan.status === "review") {
        needsReview = true;
        reviewSignal = "scam";
        reviewSource = "phish-review-post";
        aiStatusReason =
          aiStatusReason !== undefined
            ? `${aiStatusReason} · ${phishScan.reason}`
            : phishScan.reason;
      }
      const racismScan = scanForRacism(caption);
      if (racismScan.status === "blocked") {
        await escalateSilently(ctx, userId, 5, "harassment", "racism-block-post");
        return {
          ok: false,
          error: `That can't be posted — ${racismScan.reason}.`,
        };
      }
      if (racismScan.status === "review") {
        needsReview = true;
        racismReviewCategory = racismScan.category;
        racismEvasionScore = racismScan.evasionScore;
        aiStatusReason =
          aiStatusReason !== undefined
            ? `${aiStatusReason} · ${racismScan.reason}`
            : racismScan.reason;
      }
    }
    // Review-tier content counts toward a quiet shadowban exactly like a
    // review-tier post, so a share spammer can't use shares to dodge the
    // flag (see the post path for the reasoning).
    if (needsReview) {
      await escalateSilently(
        ctx,
        userId,
        2,
        reviewSignal,
        reviewSource,
      );
    }
    const shareId = await ctx.db.insert("posts", {
      authorId: userId,
      content: caption,
      sharedFromId: target._id,
      tags,
      aiStatus: needsReview ? "review" : "clean",
      aiStatusReason: needsReview ? aiStatusReason : undefined,
      racismReviewCategory,
      racismEvasionScore,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      reportCount: 0,
    });
    const me = await ctx.db.get(userId);
    await ctx.db.patch(userId, { postsCount: (me?.postsCount ?? 0) + 1 });
    if (caption.length > 0) {
      await notifyMentions(ctx, caption, userId, shareId);
    }
    // Record the share: a row for the original's share count plus a
    // notification to its author (skipped for your own posts).
    const existing = await ctx.db
      .query("shares")
      .withIndex("by_pair", (q) =>
        q.eq("userId", userId).eq("postId", target._id),
      )
      .first();
    if (existing === null) {
      await ctx.db.insert("shares", { postId: target._id, userId });
      await ctx.db.patch(target._id, { shareCount: target.shareCount + 1 });
      if (target.authorId !== userId) {
        await ctx.db.insert("notifications", {
          userId: target.authorId,
          type: "share",
          actorId: userId,
          postId: target._id,
          read: false,
        });
      }
    }
    return {
      ok: true,
      postId: shareId,
      aiReviewReason: needsReview ? aiStatusReason : undefined,
    };
  },
});

export const listUserPosts = query({
  args: { userId: v.id("users"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { userId, paginationOpts }) => {
    const viewerId = await getAuthUserId(ctx);
    const viewer = viewerId !== null ? await ctx.db.get(viewerId) : null;
    // Blocked, blocking, banned, pending-review, and shadowbanned accounts
    // are invisible to the viewer.
    const hiddenIds = await hiddenAuthorIds(ctx, viewerId);
    const silencedIds = await silencedAuthorIds(ctx, viewerId);
    const hidden = hiddenIds.includes(userId) || silencedIds.includes(userId);
    if (hidden && viewer?.role !== "admin") {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const canSeePending = viewerId === userId || viewer?.role === "admin";
    let base = ctx.db
      .query("posts")
      .withIndex("by_author", (q) => q.eq("authorId", userId));
    if (!canSeePending) {
      // Posts awaiting AI review stay hidden from other users.
      base = base.filter((q) => q.neq(q.field("aiStatus"), "review"));
    }
    const result = await base.order("desc").paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map((p) => withAuthor(ctx, p, viewerId)),
    );
    return { ...result, page };
  },
});
