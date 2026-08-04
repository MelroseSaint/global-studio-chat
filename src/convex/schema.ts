import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { authTables } from "@convex-dev/auth/server";

const schema = defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    // Privacy: salted SHA-256 hash of the normalized email. Plain-text addresses
    // are never sent to clients — surfaces get the hash and a masked form.
    emailHash: v.optional(v.string()),
    // Which salt version produced emailHash (see currentEmailHashVersion).
    // Lets a compromised salt be rotated without waiting for each user's
    // next sign-in: bump the version + salt env, redeploy, and run the
    // rehash migration to converge every existing hash in one pass.
    emailHashVersion: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // PureWire custom profile fields
    username: v.optional(v.string()),
    bio: v.optional(v.string()),
    // Profile artwork. Dual-mode: a Convex storage id (legacy/fallback) OR
    // an external Cloudinary URL once CLOUDINARY_* is configured. Null (not
    // just absent) means explicitly cleared, matching the location field.
    avatarStorageId: v.optional(v.union(v.null(), v.id("_storage"))),
    bannerStorageId: v.optional(v.union(v.null(), v.id("_storage"))),
    avatarUrl: v.optional(v.union(v.null(), v.string())),
    bannerUrl: v.optional(v.union(v.null(), v.string())),
    links: v.optional(
      v.array(
        v.object({
          platform: v.string(),
          url: v.string(),
        }),
      ),
    ),
    verified: v.optional(v.boolean()),
    role: v.optional(v.union(v.literal("user"), v.literal("creator"), v.literal("admin"))),
    // End-to-end encryption: the PUBLIC half of the account's ECDH P-256
    // keypair, as JWK JSON. Public keys are not secret — they exist so
    // anyone can derive a shared conversation key with this account. The
    // PRIVATE half is generated in the browser and never leaves the
    // device; the server holds no key material for anyone. Set by
    // dms.setDmPublicKey the first time a device opens Messages.
    dmPublicKey: v.optional(v.string()),
    followersCount: v.optional(v.number()),
    followingCount: v.optional(v.number()),
    postsCount: v.optional(v.number()),
    // Trust & safety: risk score from signup screening, the current account
    // status, and the signals that raised the score.
    riskScore: v.optional(v.number()),
    accountStatus: v.optional(
      v.union(
        v.literal("active"),
        v.literal("suspicious"),
        v.literal("restricted"),
        v.literal("banned"),
      ),
    ),
    riskReasons: v.optional(v.array(v.string())),
    // Silent moderation: a shadowbanned account looks completely normal to
    // its owner (no errors, no warnings) but its content and engagement
    // never reach other members until a human reviews it. silentFlags
    // counts abuse signals that can trigger a quiet shadowban.
    shadowban: v.optional(v.boolean()),
    silentFlags: v.optional(v.number()),
    silentFlagsUpdatedAt: v.optional(v.number()),
    // Lifetime total of silent-flag points ever escalated — unlike
    // silentFlags (which decays after a week of clean behavior), this
    // counter never resets, so admins can see an account's whole quiet
    // history in the Silenced tab even after points have decayed away.
    lifetimeSilentFlags: v.optional(v.number()),
    // Farm-network churn: when a follow was last undone inside the churn
    // window. Lets the churn detector escalate at most once per window so a
    // real user cleaning up mis-clicks counts once, not per unfollow.
    lastFollowChurnAt: v.optional(v.number()),
    // Moderation trail: the PureWire Standard principle an admin action
    // cited (and an optional note), so every restriction, ban, or silence
    // references a stated rule.
    moderationStandardId: v.optional(v.string()),
    moderationNote: v.optional(v.string()),
    // Home location: the user's optional chosen place — a public label,
    // optionally with a coarsened anchor. Coordinates are rounded to a
    // ~1 km grid on every write (never the precise point) and stripped
    // from all client responses; they exist server-side only so the Local
    // feed can center itself when live browser geolocation isn't granted.
    // Label-only rows (typed places without coordinates) stay valid. Null
    // (not just absent) means the user has explicitly removed it, and
    // updateProfile writes null to clear.
    location: v.optional(
      v.union(
        v.null(),
        v.object({
          latitude: v.optional(v.number()),
          longitude: v.optional(v.number()),
          label: v.optional(v.string()),
        }),
      ),
    ),
  })
    // Keep auth's original index names — the auth library queries these.
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_username", ["username"])
    .index("by_account_status", ["accountStatus"]),
  posts: defineTable({
    authorId: v.id("users"),
    content: v.string(),
    media: v.optional(
      v.array(
        v.object({
          // Dual-mode: a Convex storage id (legacy/fallback) OR an external
          // Cloudinary `url` + `key` (primary path once CLOUDINARY_* is set).
          storageId: v.optional(v.id("_storage")),
          url: v.optional(v.string()),
          key: v.optional(v.string()),
          kind: v.union(
            v.literal("image"),
            v.literal("video"),
            v.literal("audio"),
          ),
          // True when GPS/device metadata was removed from this item — by
          // the client re-encode or the server-side remux. Powers the tiny
          // "Metadata stripped" note next to the post's media.
          stripped: v.optional(v.boolean()),
        }),
      ),
    ),
    fingerprint: v.optional(v.string()),
    originalityVerified: v.optional(v.boolean()),
    // Verified Original fingerprinting, part two: perceptual hashes of
    // attached media (each item carries a set of variant dHash signatures
    // — original, mirrored, center-crop — and video posts carry sampled
    // frames) plus the text body's shingle set. Together they catch the
    // near-duplicates that defeat a plain fingerprint: flipped media,
    // light crops, re-encodes, speed shifts, and lightly reworded text.
    // Optional so existing posts stay valid.
    mediaHashes: v.optional(v.array(v.array(v.string()))),
    textTokens: v.optional(v.array(v.string())),
    // Anti-AI enforcement: "clean" or "review" (suspicious, awaiting a
    // human check). Posts that clearly self-identify as AI-generated are
    // rejected at creation and never stored.
    aiStatus: v.optional(v.union(v.literal("clean"), v.literal("review"))),
    // Why the post was flagged — the specific detection signals the scan
    // found (formulaic phrasing, uniform sentence lengths, generator
    // metadata, a missing scan verdict, …). Shown in the admin AI-review
    // queue so a human can judge the flag without re-reading everything.
    aiStatusReason: v.optional(v.string()),
    // Content Credentials (C2PA) provenance, verified server-side from the
    // stored media bytes: true when any attached item's manifest declared a
    // camera capture (digitalCapture/compositeCapture). Positive provenance
    // only — an AI-asserting manifest blocks at upload, so this field can
    // never be set on a post whose media declared machine-made.
    c2paVerifiedHuman: v.optional(v.boolean()),
    likeCount: v.number(),
    commentCount: v.number(),
    shareCount: v.number(),
    // How many open support tickets target this post — a live signal
    // of member concern, shown to admins in the queue. Incremented on
    // createTicket, decremented when a ticket resolves or is dismissed.
    reportCount: v.optional(v.number()),
    // Optional place the post was shared from — powers the Local feed.
    location: v.optional(
      v.object({
        latitude: v.number(),
        longitude: v.number(),
        label: v.optional(v.string()),
      }),
    ),
  })
    .index("by_author", ["authorId"])
    .index("by_fingerprint", ["fingerprint"])
    .index("by_ai_status", ["aiStatus"]),
  // Feeds order by _creationTime via the built-in per-table index that
  // Convex maintains automatically — `order("desc")` on the Global,
  // Following, Latest, and Media feed queries resolves against it, so
  // timestamp pagination stays indexed at real-time load without an
  // explicit (redundant) index declaration.
  stories: defineTable({
    authorId: v.id("users"),
    media: v.object({
      // Dual-mode: a Convex storage id (legacy/fallback) OR an external
      // Cloudinary `url` + `key` (primary path once CLOUDINARY_* is set).
      storageId: v.optional(v.id("_storage")),
      url: v.optional(v.string()),
      key: v.optional(v.string()),
      kind: v.union(
        v.literal("image"),
        v.literal("video"),
        v.literal("audio"),
      ),
      stripped: v.optional(v.boolean()),
    }),
    caption: v.optional(v.string()),
    expiresAt: v.number(),
    // Anti-AI enforcement, same policy as posts: "review" keeps the story
    // off everyone else's ring until a human clears it.
    aiStatus: v.optional(v.union(v.literal("clean"), v.literal("review"))),
    // Why the story was flagged (AI signals, suspected phishing) — shown in
    // the admin review queue so a human can judge without re-reading it.
    aiStatusReason: v.optional(v.string()),
  })
    .index("by_author", ["authorId"])
    .index("by_expiration", ["expiresAt"])
    .index("by_ai_status", ["aiStatus"]),
  urlPreviews: defineTable({
    url: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    image: v.optional(v.string()),
    domain: v.string(),
    // When this preview was fetched (and re-fetched). Powers the periodic
    // redirect-chain re-evaluation in fetchUrlPreview: a card cached before
    // a domain was blocked is stale after 24h, re-scanned, and removed.
    fetchedAt: v.optional(v.number()),
  }).index("by_url", ["url"]),
  // Server-side place search cache for the location picker. Queries run
  // against Nominatim inside PureWire's backend (the browser never talks to
  // a third party), and results are cached per normalized query for a week
  // so repeated lookups never hit the geocoder. Reverse-geocoded "my
  // current location" labels are cached under their coarsened cell key.
  placeCache: defineTable({
    query: v.string(),
    results: v.array(
      v.object({
        label: v.string(),
        latitude: v.number(),
        longitude: v.number(),
      }),
    ),
    fetchedAt: v.number(),
  }).index("by_query", ["query"]),
  follows: defineTable({
    followerId: v.id("users"),
    followingId: v.id("users"),
    // When the follow was created. Powers the silent farm-network detector:
    // instant reciprocal follows and quick follow/unfollow churn are the
    // shapes of network-boosting. Optional so pre-existing rows (created
    // before this field existed) stay valid and simply don't trigger it.
    createdAt: v.optional(v.number()),
  })
    .index("by_follower", ["followerId"])
    .index("by_following", ["followingId"])
    .index("by_pair", ["followerId", "followingId"]),
  likes: defineTable({
    userId: v.id("users"),
    postId: v.id("posts"),
  })
    .index("by_post", ["postId"])
    .index("by_user", ["userId"])
    .index("by_pair", ["userId", "postId"]),
  comments: defineTable({
    postId: v.id("posts"),
    authorId: v.id("users"),
    content: v.string(),
  })
    .index("by_post", ["postId"])
    .index("by_author", ["authorId"]),
  shares: defineTable({
    postId: v.id("posts"),
    userId: v.id("users"),
  })
    .index("by_post", ["postId"])
    .index("by_user", ["userId"])
    .index("by_pair", ["userId", "postId"]),
  notifications: defineTable({
    userId: v.id("users"),
    type: v.union(
      v.literal("follow"),
      v.literal("like"),
      v.literal("comment"),
      v.literal("share"),
      v.literal("mention"),
      v.literal("system"),
      v.literal("ticket"),
      v.literal("dm"),
    ),
    actorId: v.optional(v.id("users")),
    postId: v.optional(v.id("posts")),
    message: v.optional(v.string()),
    read: v.boolean(),
  }).index("by_user", ["userId"]),
  supportTickets: defineTable({
    userId: v.id("users"),
    subject: v.string(),
    message: v.string(),
    postId: v.optional(v.id("posts")),
    offenderId: v.optional(v.id("users")),
    violation: v.optional(v.string()),
    // The PureWire Standard principle the report or ticket cites.
    standardId: v.optional(v.string()),
    // "dismissed" = the report was reviewed and found false — keeps a
    // record so repeat false flags from the same reporter on the same
    // target can be recognized.
    status: v.union(v.literal("open"), v.literal("in_review"), v.literal("resolved"), v.literal("dismissed")),
    reply: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_status", ["status"]),
  // Trust & safety: who blocked whom (mutual hiding).
  blocks: defineTable({
    blockerId: v.id("users"),
    blockedId: v.id("users"),
  })
    .index("by_blocker", ["blockerId"])
    .index("by_blocked", ["blockedId"])
    .index("by_pair", ["blockerId", "blockedId"]),
  // Trust & safety: rolling activity budget for rate limiting.
  rateLimits: defineTable({
    userId: v.id("users"),
    action: v.string(),
    windowStart: v.number(),
  })
    .index("by_user_action", ["userId", "action"])
    .index("by_window", ["windowStart"]),
  // Trust & safety: every silent-flag escalation, with the reason (trigger),
  // points, source (which surface tripped it), and timestamp, so admins can
  // see exactly why an account was quietly silenced and when. Appended by
  // escalateSilently; read by the Security and Silenced admin tabs.
  silentFlagEvents: defineTable({
    userId: v.id("users"),
    reason: v.string(),
    points: v.number(),
    source: v.optional(v.string()),
  }).index("by_user", ["userId"]),
  // Admin audit trail for quiet moderation: every silence / unsilence (and
  // status change) with who acted, when, and the cited Standard principle,
  // so the Security tab shows exactly why each account is silenced.
  moderationLog: defineTable({
    targetUserId: v.id("users"),
    actorId: v.optional(v.id("users")), // the admin who acted; absent = system
    action: v.union(
      v.literal("silence"),
      v.literal("unsilence"),
      v.literal("restrict"),
      v.literal("ban"),
      v.literal("approve"),
      // Full restore of a moderated account, with the reason recorded.
      v.literal("reinstate"),
      v.literal("flag"),
    ),
    standardId: v.optional(v.string()),
    note: v.optional(v.string()),
  })
    .index("by_target", ["targetUserId"])
    .index("by_actor", ["actorId"]),
  // "Keep me signed in" per-device preference: which authSessions were
  // deliberately opted down to the short 30-day horizon by their owner.
  // Only opt-outs are recorded — the permanent 10-year default needs no
  // row. The session-lifetime CI audit reads this so a deliberate choice
  // never trips the "nothing may expire within a year" regression gate.
  sessionPrefs: defineTable({
    sessionId: v.id("authSessions"),
    remember: v.boolean(),
  }).index("by_session", ["sessionId"]),
  // Private, one-way removal log. When an admin permanently removes an
  // account, this record snapshots the removed user's public identity —
  // handle, display name, and the salted one-way email hash (never the
  // plain address) — together with who acted and the cited Standard
  // principle, BEFORE the erasure sweep starts. The table is deliberately
  // never swept (see eraseAccount), so "who was removed, when, and by
  // whom" is always knowable. It is strictly one-way: no restore path
  // exists, and nothing in this record can recreate the account or its data.
  removalLog: defineTable({
    userId: v.id("users"),
    username: v.optional(v.string()),
    name: v.optional(v.string()),
    emailHash: v.optional(v.string()),
    actorId: v.optional(v.id("users")), // the admin who acted; absent = system
    standardId: v.optional(v.string()),
    note: v.optional(v.string()),
  }),
  // End-to-end encrypted direct messages. Every message body and attachment
  // is AES-GCM ciphertext produced in the sender's browser; the server
  // stores ONLY {ciphertext, iv} plus the routing metadata (who, when,
  // which thread). Plaintext and keys never touch Convex — see
  // src/lib/dm-crypto.ts for the scheme.
  dmConversations: defineTable({
    // Exactly two members, stored in sorted order (see sortedPair in
    // dms.ts) so the pair has a stable identity regardless of who opened
    // it first. Two scalar columns instead of an array: both are indexed
    // directly, so "all conversations for me" is two index lookups with
    // fully-typed queries.
    participantA: v.id("users"),
    participantB: v.id("users"),
    // The newest message's time + sender, kept on the conversation so the
    // inbox list and the unread badge are one cheap query instead of a
    // scan of every message.
    lastMessageAt: v.optional(v.number()),
    lastMessageSenderId: v.optional(v.id("users")),
  })
    .index("by_participant_a", ["participantA"])
    .index("by_participant_b", ["participantB"]),
  dmMessages: defineTable({
    conversationId: v.id("dmConversations"),
    senderId: v.id("users"),
    // AES-GCM ciphertext of the message body (base64). Empty for a
    // media-only message.
    ciphertext: v.string(),
    // The 12-byte AES-GCM nonce (base64).
    iv: v.string(),
    // Optional attachment: an encrypted file. Dual-mode like post media —
    // a Convex storage id (legacy/fallback) or an external Cloudinary
    // url + key (primary path). The stored bytes are ciphertext either way;
    // the file is decrypted in the recipient's browser after download.
    media: v.optional(
      v.object({
        storageId: v.optional(v.id("_storage")),
        url: v.optional(v.string()),
        key: v.optional(v.string()),
        iv: v.string(),
        mime: v.optional(v.string()),
        kind: v.union(
          v.literal("image"),
          v.literal("video"),
          v.literal("audio"),
        ),
      }),
    ),
  }).index("by_conversation", ["conversationId"]),
  // Per-device "read up to here" watermark for one conversation, so the
  // unread badge is accurate without ever touching message bodies.
  dmReads: defineTable({
    conversationId: v.id("dmConversations"),
    userId: v.id("users"),
    lastReadAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_user_conversation", ["userId", "conversationId"]),
  // Data-driven blocklist engine: banned domains live in the database (not
  // only in code) so admins can add, re-categorize, or re-enable entries
  // without a deploy, and external blocklist sources can sync into them.
  // The static core list in phishing.ts seeds this table (see
  // blocklist.importCoreBlocklist); the scan layer checks code AND this
  // table on every post, story, comment, bio, link, and pre-encryption DM.
  blockedDomains: defineTable({
    // Canonical registrable domain, lowercased, no scheme/trailing dot.
    domain: v.string(),
    category: v.union(
      v.literal("adult_explicit"),
      v.literal("adult_creator"),
      v.literal("adult_porn"),
      v.literal("adult_cam"),
      v.literal("adult_clips"),
      v.literal("adult_chat"),
      v.literal("adult_escort"),
      v.literal("adult_dating"),
      v.literal("adult_fetish"),
      v.literal("adult_community"),
      v.literal("adult_redirect"),
      v.literal("adult_other"),
    ),
    // What happens when a URL on this domain is found: rejected outright
    // (block) or sent to the human review queue (review).
    action: v.union(v.literal("block"), v.literal("review")),
    // Where the entry came from: "core" (seeded from phishing.ts),
    // "manual" (admin-added), or the name of a synced external source.
    source: v.string(),
    // 0..1 confidence in the block, from the source that supplied it.
    confidence: v.number(),
    // Whether subdomains inherit the block (m.onlyfans.com counts when the
    // registrable onlyfans.com is listed and this is true).
    blockSubdomains: v.boolean(),
    active: v.boolean(),
    addedAt: v.number(),
    updatedAt: v.number(),
    lastVerifiedAt: v.optional(v.number()),
  })
    .index("by_domain", ["domain"])
    .index("by_category", ["category"])
    .index("by_active", ["active"]),
  // Pattern-level blocks (e.g. a whole scam TLD or a URL shape). Each
  // pattern is matched against the raw URL as a case-insensitive substring;
  // a cheap supplement to exact-domain blocking.
  blockedUrlPatterns: defineTable({
    pattern: v.string(),
    category: v.string(),
    action: v.union(v.literal("block"), v.literal("review")),
    active: v.boolean(),
    source: v.string(),
    addedAt: v.number(),
  }).index("by_active", ["active"]),
  // External blocklist feeds that sync into blockedDomains. Formats:
  // "domain" = one domain per line, "hosts" = hosts-file "0.0.0.0 domain",
  // "adguard" = adblock-style "||domain^", "json" = array of strings.
  domainSources: defineTable({
    name: v.string(),
    url: v.string(),
    format: v.union(
      v.literal("domain"),
      v.literal("hosts"),
      v.literal("adguard"),
      v.literal("json"),
      v.literal("custom"),
    ),
    enabled: v.boolean(),
    lastFetchedAt: v.optional(v.number()),
    lastSuccessfulSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  }).index("by_enabled", ["enabled"]),
  // Cache of the last scan verdict per URL. urlHash is an FNV-1a hash of
  // the normalized URL; the row remembers what the platform decided the
  // last time a link appeared, so admins can audit why a link was blocked
  // and the scanner can skip re-checking known-safe URLs.
  linkScanResults: defineTable({
    urlHash: v.string(),
    originalUrl: v.string(),
    normalizedUrl: v.string(),
    hostname: v.optional(v.string()),
    finalHostname: v.optional(v.string()),
    verdict: v.union(
      v.literal("allowed"),
      v.literal("blocked"),
      v.literal("review"),
      v.literal("unreachable"),
    ),
    category: v.optional(v.string()),
    matchedDomain: v.optional(v.string()),
    redirectChain: v.optional(v.array(v.string())),
    scannedAt: v.number(),
  })
    .index("by_url_hash", ["urlHash"])
    .index("by_verdict", ["verdict"]),
});

export default schema;
