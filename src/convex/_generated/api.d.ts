/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as admin from "../admin.js";
import type * as aiContent from "../aiContent.js";
import type * as auth from "../auth.js";
import type * as auth_email from "../auth/email.js";
import type * as farmNetwork from "../farmNetwork.js";
import type * as http from "../http.js";
import type * as links from "../links.js";
import type * as location from "../location.js";
import type * as media from "../media.js";
import type * as notifications from "../notifications.js";
import type * as places from "../places.js";
import type * as posts from "../posts.js";
import type * as privacy from "../privacy.js";
import type * as security from "../security.js";
import type * as staticHosting from "../staticHosting.js";
import type * as stories from "../stories.js";
import type * as support from "../support.js";
import type * as testHarness from "../testHarness.js";
import type * as users from "../users.js";
import type * as videoStrip from "../videoStrip.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  admin: typeof admin;
  aiContent: typeof aiContent;
  auth: typeof auth;
  "auth/email": typeof auth_email;
  farmNetwork: typeof farmNetwork;
  http: typeof http;
  links: typeof links;
  location: typeof location;
  media: typeof media;
  notifications: typeof notifications;
  places: typeof places;
  posts: typeof posts;
  privacy: typeof privacy;
  security: typeof security;
  staticHosting: typeof staticHosting;
  stories: typeof stories;
  support: typeof support;
  testHarness: typeof testHarness;
  users: typeof users;
  videoStrip: typeof videoStrip;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
