#!/usr/bin/env node
/**
 * Follow-list end-to-end seed / cleanup for the live platform.
 *
 * The follow lists (listFollowers / listFollowing) need real follow rows to
 * walk in the browser, so this script seeds three throwaway qa_ accounts with
 * real sessions and a small, realistic follow graph:
 *
 *   qa_carla01 ──follows──► qa_alice01, qa_robin01  (populates the primary
 *                                                    viewer's Following list)
 *   qa_alice01 ◄──follows──► qa_robin01             (reciprocal, so each
 *                                                    qa profile has both
 *                                                    a Follower and a
 *                                                    Following row)
 *
 * The primary viewer is deliberately a qa_ account, NOT the real admin: the
 * test-isolation layer forbids real members from following qa_ handles (a
 * follow row would leave test traces on a real account's graph), so any
 * script that has a real account follow a qa_ handle fails by design.
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
  process.env.CONVEX_URL ?? "https://jovial-axolotl-209.convex.cloud";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "melroseadmin";
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
  { name: "Carla Follow", username: "qa_carla01" },
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

  // 2. The primary qa viewer follows the other two — populates the primary
  //    profile's Following list. (A real account must never follow a qa_
  //    handle — the isolation guard rejects it — so no admin session here.)
  const primaryClient = new ConvexHttpClient(CONVEX_URL);
  primaryClient.setAuth(qa[0].token);
  for (const u of qa.slice(1)) {
    await primaryClient.mutation(api.users.follow, { username: u.username });
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
        primary: { userId: qa[0].userId, username: qa[0].username, token: qa[0].token },
        qa: qa.map((u) => ({ userId: u.userId, username: u.username, token: u.token })),
      },
      null,
      2,
    ),
  );
  console.log("Seeded follow graph:");
  console.log(`  ${qa[0].username} → ${qa.slice(1).map((u) => u.username).join(", ")}`);
  console.log(`  ${qa[1].username} ↔ ${qa[2].username} (reciprocal)`);
  console.log(`Tokens saved to ${SEED_FILE} for the cleanup run.`);
}

async function cleanup() {
  const client = new ConvexHttpClient(CONVEX_URL);

  let state = null;
  try {
    state = JSON.parse(readFileSync(SEED_FILE, "utf8"));
  } catch {
    console.log(`No seed file at ${SEED_FILE} — best-effort rescue cleanup.`);
  }
  const qa = state?.qa ?? [];
  // A rescue run without a seed file still knows the qa_ usernames this
  // script owns: resolve their ids via getProfile and mint nothing (their
  // sessions are gone), so only the unfollow + deletion can run.
  const known = qa.map((u) => u.username);
  for (const username of QA.map((q) => q.username)) {
    if (!known.includes(username)) {
      const prof = await client.query(api.users.getProfile, {
        username,
      });
      if (prof !== null && prof.username === username) {
        qa.push({ userId: prof._id, username, token: null });
      }
    }
  }

  // 1. Reverse the graph with the same identities: each qa account unfollows
  //    every other (when its token survived).
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
