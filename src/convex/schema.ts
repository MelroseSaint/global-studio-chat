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
    // Set when the account's email domain is on the disposable/temporary/
    // forwarding denylist (see emailGate.ts). Signups are rejected at
    // creation; this flag marks accounts whose domain was added to the list
    // after signup — caught at verification and routed to human review.
    disposableEmailDomain: v.optional(v.boolean()),
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
    // Verdict from the server-side AI media scan, applied to profile
    // artwork (avatar/banner) at update time — no weaker path than posts.
    // Stored so the admin queue and audits see which signal flagged it.
    aiMediaStatus: v.optional(
      v.union(
        v.literal("clean"),
        v.literal("review"),
        v.literal("blocked"),
      ),
    ),
    aiEvidence: v.optional(v.any()),
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
    // Temporary suspension: when set, the account is restricted until this
    // timestamp (unix ms) elapses, then it auto-returns to active on its
    // next activity (see enforceActive in security.ts). Carries the
    // duration so the Security tab can show "suspended until" instead of
    // a bare status. Cleared by reinstateAccount/setAccountStatus(active).
    suspendedUntil: v.optional(v.number()),
    // Who may start a conversation with this user. "everyone" is the
    // default; "following" only allows accounts the user follows;
    // "nobody" blocks all inbound DM requests before any ciphertext
    // is ever generated or stored.
    dmPermission: v.optional(
      v.union(
        v.literal("everyone"),
        v.literal("following"),
        v.literal("nobody"),
      ),
    ),
    // Personal keyword/phrase mute list. Posts, comments, and DM message
    // previews containing any muted term are hidden from this user's
    // views. Stored here (not a separate table) because it's a per-user
    // preference, exactly like links/location.
    mutedKeywords: v.optional(v.array(v.string())),
    // Video autoplay preference ("auto" = follow the device policy, or an
    // explicit true/false the user chose in Settings). Account data: synced
    // from the device on every change, included in the data export, and
    // erased with the account — the browser-local copy is only a cache.
    videoAutoplay: v.optional(v.union(v.literal("auto"), v.boolean())),
    // Browser-automation signal: a coarse 0–100 likelihood that this
    // account's browser is being driven by automation (headless,
    // Playwright/Puppeteer/CDP), computed client-side and filed by
    // automation.report. Only the score + matched signal names are ever
    // stored — never a raw fingerprint. Feeds the silent-flag pipeline.
    automationScore: v.optional(v.number()),
    automationSignals: v.optional(v.array(v.string())),
    automationReportedAt: v.optional(v.number()),
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
    // Structured evidence from the multi-signal media assessment — byte
    // scan verdict, C2PA provenance, and OCR racism result. Shown in the
    // admin review queue's evidence panel so a moderator sees exactly
    // which signal triggered the flag.
    aiEvidence: v.optional(v.any()),
    // Content Credentials (C2PA) provenance, verified server-side from the
    // stored media bytes: true when any attached item's manifest declared a
    // camera capture (digitalCapture/compositeCapture). Positive provenance
    // only — an AI-asserting manifest blocks at upload, so this field can
    // never be set on a post whose media declared machine-made.
    c2paVerifiedHuman: v.optional(v.boolean()),
    // The tool that created the C2PA manifest (claim_generator from the
    // Content Credentials). E.g. "Adobe Photoshop 26.0" or "Google SynthID".
    // Null when C2PA was absent or unreadable.
    c2paClaimGenerator: v.optional(v.string()),
    // The creator's own declaration during upload: how the work was made.
    // Required on every NEW post. "ai-generated" is rejected at createPost;
    // "ai-assisted" is allowed but flagged for review with a visible chip.
    // Optional so existing posts without this field don't break validation.
    creatorDisclosure: v.optional(v.union(
      v.literal("human-made"),
      v.literal("ai-assisted"),
      v.literal("ai-generated"),
    )),
    // Racism-prevention review data: set when a post enters the review
    // queue with a racism signal. The racism-review admin tab queries these
    // fields so a moderator can see the matched category and evasion score
    // without parsing aiStatusReason.
    racismReviewCategory: v.optional(v.string()),
    racismEvasionScore: v.optional(v.number()),
    likeCount: v.number(),
    commentCount: v.number(),
    shareCount: v.number(),
    // How many open support tickets target this post — a live signal
    // of member concern, shown to admins in the queue. Incremented on
    // createTicket, decremented when a ticket resolves or is dismissed.
    reportCount: v.optional(v.number()),
    // Comment control: when true, no one can add new comments. The author
    // (or an admin) locks a post to stop the thread — replies to existing
    // comments remain visible but new top-level comments are rejected.
    commentsLocked: v.optional(v.boolean()),
    // When the author disabled comments (unix ms). Shown as "Comments
    // disabled" on the post; null/absent = comments still open.
    commentsLockedAt: v.optional(v.number()),
    // Per-post opt-out of the auto-close policy: true = this thread stays
    // open forever (the default closes threads after a set age or comment
    // count — see posts.isCommentThreadClosed). Absent = policy applies.
    autoCloseComments: v.optional(v.boolean()),
    // When the author was last notified that this thread auto-closed (unix
    // ms; see posts.maybeNotifyAutoClosed). Absent = never told. The weekly
    // cooldown (posts.COMMENT_AUTO_CLOSE_NOTIFY_COOLDOWN_MS) is measured
    // from here, so an opted-out-then-reverted thread can notify again —
    // but never more than once per week.
    commentsAutoClosedNotifiedAt: v.optional(v.number()),
    // When this thread most recently BECAME auto-closed (unix ms; see
    // posts.maybeNotifyAutoClosed). Set at the write-time crossing, on
    // opt-out revert (setAutoCloseComments), and by the nightly sweep's
    // first observation. Compared against commentsAutoClosedNotifiedAt to
    // tell a NEW close (re-notify after the cooldown) from a thread that
    // simply stayed closed (already pinged — stay silent).
    commentsAutoClosedAt: v.optional(v.number()),
    // True for posts the QA harness created AS a real account (e.g. the
    // real admin) to drive an end-to-end check. Their author is NOT a
    // reserved qa_/pwtest handle, so username-based isolation can't spot
    // them — this marker is what keeps them out of the sitemap and public
    // feeds, and what lets the nightly cleanup sweep erase them even when
    // a crashed CI run skips its own finally-cleanup.
    qaFixture: v.optional(v.boolean()),
    // Optional place the post was shared from — powers the Local feed.
    location: v.optional(
      v.object({
        latitude: v.number(),
        longitude: v.number(),
        label: v.optional(v.string()),
      }),
    ),
    // When set, this post is a SHARE of another post (Facebook-style): the
    // row carries its own caption as `content` (possibly empty for a plain
    // repost) and renders the original post — with its media — embedded
    // beneath. Points at the ORIGINAL post, never at another share, so
    // share chains are flattened to one level at creation (see createShare).
    sharedFromId: v.optional(v.id("posts")),
    // Explicitly tagged users (resolved from @mentions in the content at
    // creation). Structured so posts can show a "with @alice" line and
    // notifications fire for every tag, on original posts and shares alike.
    tags: v.optional(v.array(v.id("users"))),
  })
    .index("by_author", ["authorId"])
    .index("by_fingerprint", ["fingerprint"])
    .index("by_ai_status", ["aiStatus"])
    .index("by_shared_from", ["sharedFromId"]),
  // Feeds order by _creationTime via the built-in per-table index that
  // Convex maintains automatically — `order("desc")` on the Global,
  // Following, Latest, and Media feed queries resolves against it, so
  // timestamp pagination stays indexed at real-time load without an
  // explicit (redundant) index declaration.
  // Who viewed a story. One row per viewer per story — re-viewing just
  // bumps viewedAt. Only the story's author (or an admin) may read the
  // list; a viewer never learns anyone else saw the same story. Rows are
  // swept with their story when it expires or is moderated.
  storyViews: defineTable({
    storyId: v.id("stories"),
    viewerId: v.id("users"),
    viewedAt: v.number(),
  })
    .index("by_story", ["storyId"])
    .index("by_story_viewer", ["storyId", "viewerId"])
    // Orders the author's viewer list by most-recent view (re-views bump
    // viewedAt), so the paginated list matches the "viewed X ago" labels.
    .index("by_story_viewed_at", ["storyId", "viewedAt"])
    .index("by_viewer", ["viewerId"]),
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
    // Structured evidence from the multi-signal media assessment — byte
    // scan verdict, C2PA provenance, and OCR racism result. Same shape as
    // posts.aiEvidence.
    aiEvidence: v.optional(v.any()),
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
    // When the author last edited the comment (unix ms). Shown as a small
    // "edited" note next to the timestamp; absent on new comments.
    editedAt: v.optional(v.number()),
    // Denormalized like tally for the heart button on a comment, patched on
    // like/unlike — the same counter discipline as posts.likeCount. A
    // sandboxed account's absorbed like inserts a row without bumping it.
    likeCount: v.optional(v.number()),
    // Threaded replies: points at the top-level comment this replies to;
    // absent = top-level. Replies to a reply are re-rooted to the top-level
    // comment on insert, so the tree stays one level deep.
    parentId: v.optional(v.id("comments")),
    // Denormalized count of the replies hanging under this comment, patched
    // on reply/delete — the same counter discipline as posts.commentCount.
    replyCount: v.optional(v.number()),
    // Optional reference to a post shared into this comment, mirroring the
    // DM share flow: the comment renders the post as a preview card (media
    // included). Post ids are public metadata, so the reference travels in
    // the clear like the author/timestamp — the viewer's client fetches the
    // post through the normal visibility rules.
    sharedPostId: v.optional(v.id("posts")),
    // Optional single media item (audio) attached to the comment — a voice
    // note, recorded or uploaded by the author. Same dual-mode shape as
    // post/story media: a Cloudinary `url` + `key` (primary) or a Convex
    // storage id (fallback). The bytes never live in Convex — only the
    // reference — mirroring the media architecture everywhere else.
    media: v.optional(
      v.object({
        storageId: v.optional(v.id("_storage")),
        url: v.optional(v.string()),
        key: v.optional(v.string()),
        kind: v.union(
          v.literal("image"),
          v.literal("video"),
          v.literal("audio"),
        ),
        stripped: v.optional(v.boolean()),
        title: v.optional(v.string()),
      }),
    ),
  })
    .index("by_post", ["postId"])
    .index("by_author", ["authorId"])
    // Serves the "Top" comment sort (thread ordered by like count, highest
    // first) and the "Newest" sort, each restricted to top-level comments:
    // parentId is part of the key so undefined parents can be filtered
    // inside the index instead of post-paginate.
    .index("by_post_parent", ["postId", "parentId"])
    .index("by_post_parent_likes", ["postId", "parentId", "likeCount"])
    // Reply sweeps: finding every reply hanging under a comment when the
    // comment dies (user delete, post delete, account erasure).
    .index("by_parent", ["parentId"]),
  commentLikes: defineTable({
    commentId: v.id("comments"),
    userId: v.id("users"),
  })
    .index("by_comment", ["commentId"])
    .index("by_user", ["userId"])
    .index("by_pair", ["userId", "commentId"]),
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
      v.literal("reply"),
      v.literal("share"),
      v.literal("mention"),
      v.literal("system"),
      v.literal("ticket"),
      v.literal("dm"),
      // A post shared into a DM thread — distinct from plain messages so
      // the bell can say "shared a post with you" and deep-link to the
      // exact conversation (see dms.sendMessage).
      v.literal("dm-share"),
      // A post shared into one of your post's comments — distinct from a
      // plain comment so the bell can say "shared a post in your post's
      // comments" and preview the shared post (see posts.addComment).
      v.literal("comment-share"),
      // The post's author removed one of your comments (see
      // posts.deleteComment) — moderation isn't silent.
      v.literal("comment-deleted"),
      // The auto-close policy closed one of your post's threads (see
      // posts.maybeNotifyAutoClosed) — a heads-up so the author can
      // reopen it or opt the post out.
      v.literal("comment-auto-closed"),
    ),
    actorId: v.optional(v.id("users")),
    postId: v.optional(v.id("posts")),
    // The DM conversation a "dm-share" notification points at, so the
    // bell entry opens the thread (with the shared card) directly.
    conversationId: v.optional(v.id("dmConversations")),
    // The post shared into the host post's comments (a "comment-share"
    // notification). postId stays the host post, so Open/View lands on the
    // thread where the share landed; this field carries the shared post for
    // the preview.
    sharedPostId: v.optional(v.id("posts")),
    message: v.optional(v.string()),
    read: v.boolean(),
  })
    .index("by_user", ["userId"])
    // Delete-time engagement sweeps look rows up by the referenced post
    // (sweepPostEngagement): postId for the host the bell entry points at,
    // sharedPostId for comment-share preview rows. Indexed so a deletion
    // never scans the whole table.
    .index("by_post", ["postId"])
    .index("by_shared_post", ["sharedPostId"]),
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
      // Time-limited suspension (a restriction with an expiry), and the
      // admin lifting it early.
      v.literal("suspend"),
      v.literal("unsuspend"),
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
  // Deploy-commit ledger (see deployStatus.ts): one row keyed "latest"
  // recording the git SHA the production backend was last deployed from.
  // Written by migrations.yml right after `convex deploy` succeeds and read
  // by the nightly drift job, so the drift-gated redeploy can compare the
  // live backend commit against main HEAD even though Convex exposes no
  // commit metadata to a deploy key. Single row by construction.
  deployStatus: defineTable({
    key: v.literal("latest"),
    sha: v.string(),
    recordedAt: v.number(),
  }).index("by_key", ["key"]),
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
    // Optional reference to a post shared into the thread. Post ids are
    // public metadata (not message content), so the reference travels in
    // the clear like the sender/timestamp — the recipient's client fetches
    // the post through the normal visibility rules and renders a preview
    // card (media included). The text caption stays E2E-encrypted in
    // `ciphertext` like any other message.
    sharedPostId: v.optional(v.id("posts")),
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
  // Admin announcements: shown in a subtle dismissible banner on the home
  // page. Each user can dismiss an announcement once — the dismissal is
  // recorded so the banner stays hidden even after a reload.
  // Status: "active" (visible now), "scheduled" (auto-activates when
  // scheduledAt elapses), "inactive" (manually hidden).
  announcements: defineTable({
    title: v.string(),
    body: v.string(),
    category: v.union(
      v.literal("platform"),
      v.literal("safety"),
      v.literal("feature"),
      v.literal("event"),
      v.literal("community"),
    ),
    status: v.union(
      v.literal("active"),
      v.literal("scheduled"),
      v.literal("inactive"),
    ),
    // Unix ms timestamp when a scheduled announcement should go live.
    // Absent for immediately-active announcements.
    scheduledAt: v.optional(v.number()),
    authorId: v.id("users"),
  })
    .index("by_status", ["status"])
    .index("by_scheduled", ["scheduledAt"]),
  announcementDismissals: defineTable({
    announcementId: v.id("announcements"),
    userId: v.id("users"),
  })
    .index("by_announcement", ["announcementId"])
    .index("by_user", ["userId"])
    .index("by_pair", ["userId", "announcementId"]),
  // Self-auditing session signals: a lightweight, one-way fingerprint of
  // each session's browser context. PureWire never stores IP addresses or
  // user agents in the clear — only a salted hash of the UA string plus a
  // coarse region token derived from a few request hints. When an existing
  // session suddenly presents a wildly different fingerprint, the session
  // is silently revoked and the user must re-authenticate with a one-time
  // email code.
  sessionSignals: defineTable({
    sessionId: v.id("authSessions"),
    uaHash: v.optional(v.string()),
    regionToken: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_session", ["sessionId"]),
  // Backend-verified admin IP binding. Unlike sessionSignals (which the
  // BROWSER computes and reports), this row is written by the
  // /admin/ip/verify HTTP action from the IP address Convex's edge actually
  // observed on the request (cf-connecting-ip / x-forwarded-for) — the
  // admin can never claim an IP; the backend records what it saw. The raw
  // address is never stored — only a salted one-way hash, matching the
  // platform's "no IPs in the clear" posture. Admin power (requireAdmin)
  // is gated on this binding being fresh, so a stolen session used from a
  // different network is silently revoked the moment it re-verifies — and
  // denied once the binding goes stale even if it never re-verifies.
  adminIpBindings: defineTable({
    sessionId: v.id("authSessions"),
    ipHash: v.string(),
    verifiedAt: v.number(),
  }).index("by_session", ["sessionId"]),
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
      // The destination answered with an anti-bot / CAPTCHA challenge
      // (Cloudflare, DataDome, …) — recorded by the link scanner so the
      // audit trail shows why no card was shown.
      v.literal("challenged"),
    ),
    category: v.optional(v.string()),
    matchedDomain: v.optional(v.string()),
    redirectChain: v.optional(v.array(v.string())),
    scannedAt: v.number(),
  })
    .index("by_url_hash", ["urlHash"])
    .index("by_verdict", ["verdict"]),

  // Account-creation velocity counter: one row per hourly bucket, incremented
  // on each new account (see SIGNUP_VELOCITY_LIMIT in auth.ts). Breached
  // buckets flag signups for human review instead of blocking registration.
  signupVelocity: defineTable({
    bucket: v.number(),
    count: v.number(),
  }).index("by_bucket", ["bucket"]),
});

export default schema;
