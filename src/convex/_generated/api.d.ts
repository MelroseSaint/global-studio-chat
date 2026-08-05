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
import type * as announcements from "../announcements.js";
import type * as auth from "../auth.js";
import type * as auth_email from "../auth/email.js";
import type * as automation from "../automation.js";
import type * as blocklist from "../blocklist.js";
import type * as dms from "../dms.js";
import type * as exportData from "../exportData.js";
import type * as farmNetwork from "../farmNetwork.js";
import type * as http from "../http.js";
import type * as links from "../links.js";
import type * as linksInternal from "../linksInternal.js";
import type * as location from "../location.js";
import type * as media from "../media.js";
import type * as mediaCleanup from "../mediaCleanup.js";
import type * as mediaStorage from "../mediaStorage.js";
import type * as migrations from "../migrations.js";
import type * as mutes from "../mutes.js";
import type * as notifications from "../notifications.js";
import type * as og from "../og.js";
import type * as phishing from "../phishing.js";
import type * as places from "../places.js";
import type * as placesInternal from "../placesInternal.js";
import type * as posts from "../posts.js";
import type * as pow from "../pow.js";
import type * as privacy from "../privacy.js";
import type * as security from "../security.js";
import type * as sessionAudit from "../sessionAudit.js";
import type * as staticHosting from "../staticHosting.js";
import type * as status from "../status.js";
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
  announcements: typeof announcements;
  auth: typeof auth;
  "auth/email": typeof auth_email;
  automation: typeof automation;
  blocklist: typeof blocklist;
  dms: typeof dms;
  exportData: typeof exportData;
  farmNetwork: typeof farmNetwork;
  http: typeof http;
  links: typeof links;
  linksInternal: typeof linksInternal;
  location: typeof location;
  media: typeof media;
  mediaCleanup: typeof mediaCleanup;
  mediaStorage: typeof mediaStorage;
  migrations: typeof migrations;
  mutes: typeof mutes;
  notifications: typeof notifications;
  og: typeof og;
  phishing: typeof phishing;
  places: typeof places;
  placesInternal: typeof placesInternal;
  posts: typeof posts;
  pow: typeof pow;
  privacy: typeof privacy;
  security: typeof security;
  sessionAudit: typeof sessionAudit;
  staticHosting: typeof staticHosting;
  status: typeof status;
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
