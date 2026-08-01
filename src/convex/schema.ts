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
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // PureWire custom profile fields
    username: v.optional(v.string()),
    bio: v.optional(v.string()),
    avatarStorageId: v.optional(v.id("_storage")),
    bannerStorageId: v.optional(v.id("_storage")),
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
    followersCount: v.optional(v.number()),
    followingCount: v.optional(v.number()),
    postsCount: v.optional(v.number()),
  })
    // Keep auth's original index names — the auth library queries these.
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_username", ["username"]),
  posts: defineTable({
    authorId: v.id("users"),
    content: v.string(),
    media: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          kind: v.union(
            v.literal("image"),
            v.literal("video"),
            v.literal("audio"),
          ),
        }),
      ),
    ),
    fingerprint: v.optional(v.string()),
    originalityVerified: v.optional(v.boolean()),
    likeCount: v.number(),
    commentCount: v.number(),
    shareCount: v.number(),
  })
    .index("by_author", ["authorId"])
    .index("by_fingerprint", ["fingerprint"]),
  stories: defineTable({
    authorId: v.id("users"),
    media: v.object({
      storageId: v.id("_storage"),
      kind: v.union(
        v.literal("image"),
        v.literal("video"),
        v.literal("audio"),
      ),
    }),
    caption: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_author", ["authorId"])
    .index("by_expiration", ["expiresAt"]),
  urlPreviews: defineTable({
    url: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    image: v.optional(v.string()),
    domain: v.string(),
  }).index("by_url", ["url"]),
  follows: defineTable({
    followerId: v.id("users"),
    followingId: v.id("users"),
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
    status: v.union(v.literal("open"), v.literal("in_review"), v.literal("resolved")),
    reply: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_status", ["status"]),
});

export default schema;
