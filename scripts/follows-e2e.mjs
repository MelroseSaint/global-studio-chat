#!/usr/bin/env node
/**
 * Follow-list end-to-end seed / cleanup for the live platform.
 *
 * The follow lists (listFollowers / listFollowing) need real follow rows to
 * walk in the browser, so this script seeds two throwaway qa_ accounts with
 * real sessions and a small, realistic follow graph:
 *
 *   adminmelrose ──follows──► qa_alice01, qa_robin01   (populates admin's
 *                                                       Following list)
 *   qa_alice01 ◄──follows──► qa_robin01                (reciprocal, so each
 *                                                       qa profile has both
 *                                                       a Follower and a
 *                                                       Following row)
 *
 * Run against production with the harness enabled:
 *
 *   TEST_HARNESS_SECRET=<secret> node scripts/follows-e2e.mjs seed
 *   … walk the lists in the browser …
 *   TEST_HARNESS_SECRET=<secret> node scripts/follows-e2e.mjs cleanup
 *
 * The seed writes the minted session tokens to .freebuff/.follows-seed.json
 * (gitignored) so cleanup can reverse the graph with the same identities —
 * unfollow both directions, then delete both qa_ accounts, leaving zero
 * follow rows and no residue on the admin account.
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../src/convex/_generated/api.js";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://outgoing-seal-727.convex.cloud";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "adminmelrose";
// The workspace-level .freebuff/ (gitignored) sits two levels above this
// script when the app lives in the nested project folder.
const SEED_FILE = join(
  import.meta.dirname,
  "..",
  "..",
  ".freebuff",
  ".follows-seed.json",
);

const QA = [
  { name: "Alice Follow", username: "qa_alice01" },
  { name: "Robin Follow", username: "qa_robin01" },
];

const SECRET = process.env.TEST_HARNESS_SECRET;
if (!SECRET) {
  console.error("TEST_HARNESS_SECRET is not set — cannot use the QA harness.");
  process.exit(1);
}

async function seed() {
  const client = new ConvexHttpClient(CONVEX_URL);

  // 1. Create the two throwaway accounts (each returns a real session token).
  const qa = [];
  for (const q of QA) {
    const created = await client.mutation(api.testHarness.createTestUser, {
      name: q.name,
      username: q.username,
      secret: SECRET,
    });
    qa.push(created);
  }

  // 2. Admin follows both — populates the admin profile's Following list.
  const adminRes = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  const adminClient = new ConvexHttpClient(CONVEX_URL);
  adminClient.setAuth(adminRes.token);
  for (const u of qa) {
    await adminClient.mutation(api.users.follow, { username: u.username });
  }

  // 3. The two qa accounts follow each other — reciprocal, so each profile
  //    shows one Follower and one Following row.
  const aliceClient = new ConvexHttpClient(CONVEX_URL);
  aliceClient.setAuth(qa[0].token);
  await aliceClient.mutation(api.users.follow, { username: qa[1].username });
  const robinClient = new ConvexHttpClient(CONVEX_URL);
  robinClient.setAuth(qa[1].token);
  await robinClient.mutation(api.users.follow, { username: qa[0].username });

  writeFileSync(
    SEED_FILE,
    JSON.stringify(
      {
        admin: { token: adminRes.token, userId: adminRes.userId },
        qa: qa.map((u) => ({ userId: u.userId, username: u.username, token: u.token })),
      },
      null,
      2,
    ),
  );
  console.log("Seeded follow graph:");
  console.log(`  admin → ${qa.map((u) => u.username).join(", ")}`);
  console.log(`  ${qa[0].username} ↔ ${qa[1].username} (reciprocal)`);
  console.log(`Tokens saved to ${SEED_FILE} for the cleanup run.`);
}

async function cleanup() {
  const client = new ConvexHttpClient(CONVEX_URL);
  const adminRes = await client.mutation(api.testHarness.mintAdminSession, {
    secret: SECRET,
  });
  const adminClient = new ConvexHttpClient(CONVEX_URL);
  adminClient.setAuth(adminRes.token);

  let state = null;
  try {
    state = JSON.parse(readFileSync(SEED_FILE, "utf8"));
  } catch {
    console.log(`No seed file at ${SEED_FILE} — best-effort rescue cleanup.`);
  }
  const qa = state?.qa ?? [];
  // A rescue run without a seed file still knows the qa_ usernames this
  // script owns: resolve their ids via getProfile and mint nothing (their
  // sessions are gone), so only the admin-side unfollow + deletion can run.
  const known = qa.map((u) => u.username);
  for (const username of QA.map((q) => q.username)) {
    if (!known.includes(username)) {
      const prof = await adminClient.query(api.users.getProfile, {
        username,
      });
      if (prof !== null && prof.username === username) {
        qa.push({ userId: prof._id, username, token: null });
      }
    }
  }

  // 1. Reverse the graph with the same identities: each qa account unfollows
  //    the other (when its token survived), and admin unfollows each one.
  for (const u of qa) {
    if (u.token !== null) {
      const qClient = new ConvexHttpClient(CONVEX_URL);
      qClient.setAuth(u.token);
      for (const other of qa) {
        if (other.username !== u.username) {
          await qClient.mutation(api.users.unfollow, {
            username: other.username,
          });
        }
      }
    }
    await adminClient.mutation(api.users.unfollow, { username: u.username });
  }

  // 2. Delete both throwaway accounts (users + their auth sessions).
  for (const u of qa) {
    const res = await client.mutation(api.testHarness.deleteTestUser, {
      userId: u.userId,
      secret: SECRET,
    });
    console.log(`  deleted ${u.username}: ${JSON.stringify(res)}`);
  }

  rmSync(SEED_FILE, { force: true });
  console.log("Cleanup complete — follow graph fully reversed.");
}

const mode = process.argv[2] ?? "seed";
if (mode === "seed") {
  await seed();
} else if (mode === "cleanup") {
  await cleanup();
} else {
  console.error(`Unknown mode: ${mode} (expected "seed" or "cleanup")`);
  process.exit(1);
}
